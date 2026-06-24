import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, PricingType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { getPaymentSourceContractAdapter } from '@/services/payment-source-adapters';
import { DEFAULTS } from '@masumi/payment-core/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { extractAssetName, extractPolicyId } from '@/utils/converter/agent-identifier';
import { registryRequestOutputSchema } from '@/routes/api/registry';
import { a2aRegistryRequestOutputSchema } from '@/routes/api/registry/schemas';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { mapA2ARegistryRequestToOutput } from '@/routes/api/registry/utils';
import { serializeSupportedPaymentSources, serializeVerifications } from '../serializers';

const a2aInclude = {
	Pricing: {
		include: {
			FixedPricing: {
				include: { Amounts: { select: { unit: true, amount: true } } },
			},
		},
	},
	SmartContractWallet: {
		select: { walletVkey: true, walletAddress: true },
	},
	CurrentTransaction: {
		select: {
			txHash: true,
			status: true,
			confirmations: true,
			fees: true,
			blockHeight: true,
			blockTime: true,
		},
	},
} as const;

export const unregisterAgentSchemaInput = z.object({
	agentIdentifier: z
		.string()
		.min(57)
		.max(250)
		// PolicyId (56 hex) + assetName (1..64 hex). Reject non-hex up front so
		// downstream `extractPolicyId` / Blockfrost calls cannot be fed garbage.
		.regex(/^[0-9a-fA-F]+$/, 'agentIdentifier must be a hex string (policyId + assetName)')
		.describe('The identifier of the registration (asset) to be deregistered'),
	network: z.nativeEnum(Network).describe('The network the registration was made on'),
	smartContractAddress: z
		.string()
		.min(58)
		.max(120)
		.regex(/^(addr1|addr_test1)[0-9a-z]+$/, 'smartContractAddress must be a bech32 Cardano address')
		.optional()
		.describe('The smart contract address of the payment contract to which the registration belongs'),
});

export const unregisterAgentSchemaOutput = registryRequestOutputSchema.or(a2aRegistryRequestOutputSchema);

export const unregisterAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: unregisterAgentSchemaInput,
	output: unregisterAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof unregisterAgentSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const requestedPolicyId = extractPolicyId(input.agentIdentifier);
		const paymentSourceInclude = {
			PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
			HotWallets: {
				include: { Secret: { select: { encryptedMnemonic: true } } },
				where: { deletedAt: null },
			},
		};
		let paymentSource =
			input.smartContractAddress != null
				? await prisma.paymentSource.findUnique({
						where: {
							network_smartContractAddress: {
								network: input.network,
								smartContractAddress: input.smartContractAddress,
							},
							deletedAt: null,
						},
						include: paymentSourceInclude,
					})
				: await prisma.paymentSource.findFirst({
						where: {
							network: input.network,
							policyId: requestedPolicyId,
							deletedAt: null,
						},
						include: paymentSourceInclude,
					});

		if (paymentSource == null && input.smartContractAddress == null) {
			const smartContractAddress =
				input.network == Network.Mainnet
					? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET
					: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD;
			paymentSource = await prisma.paymentSource.findUnique({
				where: {
					network_smartContractAddress: {
						network: input.network,
						smartContractAddress: smartContractAddress,
					},
					deletedAt: null,
				},
				include: paymentSourceInclude,
			});
		}
		if (paymentSource == null) {
			throw createHttpError(404, 'Network and Address combination not supported');
		}

		const blockfrost = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);

		// Central adapter dispatch (ADR-0004) — assertNever-backed, so a new
		// PaymentSourceType is a type error rather than a silent V1 fallback.
		const adapter = getPaymentSourceContractAdapter(paymentSource.paymentSourceType);
		const { policyId } = await adapter.getRegistryScriptFromPaymentSource(paymentSource);

		const assetName = extractAssetName(input.agentIdentifier);
		const holderWallet = await blockfrost.assetsAddresses(policyId + assetName, {
			order: 'desc',
			count: 1,
		});
		if (holderWallet.length == 0) {
			throw createHttpError(404, 'Asset not found');
		}
		const vkey = resolvePaymentKeyHash(holderWallet[0].address);

		const managedHolderWallet = paymentSource.HotWallets.find((wallet) => wallet.walletVkey == vkey);
		if (managedHolderWallet == null) {
			throw createHttpError(409, 'Registered asset is not currently held by a managed wallet');
		}
		assertHotWalletInScope(ctx.walletScopeIds, managedHolderWallet.id);
		const registryRequest = await prisma.registryRequest.findUnique({
			where: {
				agentIdentifier: policyId + assetName,
			},
		});
		if (registryRequest == null) {
			const a2aRequest = await prisma.a2ARegistryRequest.findUnique({
				where: { agentIdentifier: policyId + assetName },
			});

			if (a2aRequest != null) {
				if (a2aRequest.state !== RegistrationState.RegistrationConfirmed) {
					throw createHttpError(409, `Cannot deregister agent in current state: ${a2aRequest.state}`);
				}
				const a2aResult = await prisma.a2ARegistryRequest.update({
					where: { id: a2aRequest.id, SmartContractWallet: { deletedAt: null } },
					data: { state: RegistrationState.DeregistrationRequested },
					include: a2aInclude,
				});
				return mapA2ARegistryRequestToOutput(a2aResult);
			}

			throw createHttpError(404, 'Registration not found');
		}
		// Tenant scope: the requesting key must own the row, or be admin.
		// Legacy rows (created before the requestedById column existed) have
		// NULL and are admin-only.
		if (!ctx.canAdmin && (registryRequest.requestedById == null || registryRequest.requestedById !== ctx.id)) {
			throw createHttpError(403, 'You are not authorized to deregister this agent');
		}
		// Deregister is only valid for a settled on-chain asset that is not
		// mid-flight in another lifecycle action. Blocking the in-flight states
		// (Registration*/Deregistration{Requested,Initiated}/Update{Requested,
		// Initiated}) stops a deregister from flipping a row the
		// register/update/deregister schedulers are already driving — which would
		// let two services act on the same asset and risk a double burn/mint.
		const validStatesForDeregister: RegistrationState[] = [
			RegistrationState.RegistrationConfirmed,
			RegistrationState.UpdateConfirmed,
			RegistrationState.UpdateFailed,
			RegistrationState.DeregistrationFailed,
		];
		const result = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						// Re-read state INSIDE the serializable tx to close the TOCTOU
						// window between the findUnique above and this write. A concurrent
						// update/deregister could have advanced the row; without this
						// re-check both schedulers could act on the same asset.
						const current = await tx.registryRequest.findUnique({
							where: { id: registryRequest.id },
							select: { state: true, paymentSourceId: true },
						});
						if (current == null || current.paymentSourceId !== paymentSource.id) {
							throw createHttpError(404, 'Registration not found');
						}
						if (!validStatesForDeregister.includes(current.state)) {
							throw createHttpError(
								409,
								`Agent registration cannot be deregistered in its current state: ${current.state}`,
							);
						}
						return tx.registryRequest.update({
							where: {
								id: registryRequest.id,
								SmartContractWallet: {
									deletedAt: null,
								},
							},
							data: {
								state: RegistrationState.DeregistrationRequested,
								deregistrationHotWalletId: managedHolderWallet.id,
							},
							include: {
								Pricing: {
									include: {
										FixedPricing: {
											include: { Amounts: { select: { unit: true, amount: true } } },
										},
									},
								},
								SmartContractWallet: {
									select: { walletVkey: true, walletAddress: true },
								},
								RecipientWallet: {
									select: { walletVkey: true, walletAddress: true },
								},
								ExampleOutputs: { select: { name: true, url: true, mimeType: true } },
								Verifications: true,
								SupportedPaymentSources: {
									select: {
										chain: true,
										network: true,
										paymentSourceType: true,
										address: true,
										scheme: true,
										asset: true,
										amount: true,
										decimals: true,
										payTo: true,
										resource: true,
										extra: true,
									},
								},
								CurrentTransaction: {
									select: {
										txHash: true,
										status: true,
										confirmations: true,
										fees: true,
										blockHeight: true,
										blockTime: true,
									},
								},
							},
						});
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
				),
			{ label: 'registry-deregister-route' },
		);

		return {
			...result,
			Capability: {
				name: result.capabilityName,
				version: result.capabilityVersion,
			},
			Author: {
				name: result.authorName,
				contactEmail: result.authorContactEmail,
				contactOther: result.authorContactOther,
				organization: result.authorOrganization,
			},
			Legal: {
				privacyPolicy: result.privacyPolicy,
				terms: result.terms,
				other: result.other,
			},
			AgentPricing:
				result.Pricing.pricingType == PricingType.Fixed
					? {
							pricingType: PricingType.Fixed,
							Pricing:
								result.Pricing.FixedPricing?.Amounts.map((price) => ({
									unit: price.unit,
									amount: price.amount.toString(),
								})) ?? [],
						}
					: {
							pricingType: result.Pricing.pricingType,
						},
			sendFundingLovelace: result.sendFundingLovelace?.toString() ?? null,
			supportedPaymentSources: serializeSupportedPaymentSources(result.SupportedPaymentSources),
			verifications: serializeVerifications(result.Verifications),
			Tags: result.tags,
			RecipientWallet: result.RecipientWallet,
			CurrentTransaction: result.CurrentTransaction
				? {
						...result.CurrentTransaction,
						fees: result.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
		};
	},
});
