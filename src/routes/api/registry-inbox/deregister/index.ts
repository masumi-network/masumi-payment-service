import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { Network, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { resolvePaymentKeyHash } from '@meshsdk/core-cst';
import { getRegistryScriptFromNetworkHandler } from '@/utils/generator/contract-generator';
import { DEFAULTS } from '@masumi/payment-core/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { registryInboxRequestOutputSchema } from '@/routes/api/registry-inbox';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { assertHotWalletInScope } from '@/utils/shared/wallet-scope';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { serializeInboxRegistryEntry } from '../serializers';

export const unregisterInboxAgentSchemaInput = z.object({
	agentIdentifier: z
		.string()
		.min(57)
		.max(250)
		.describe('The identifier of the inbox registration (asset) to be deregistered'),
	network: z.nativeEnum(Network).describe('The network the inbox registration was made on'),
	smartContractAddress: z
		.string()
		.max(250)
		.optional()
		.describe('The smart contract address of the payment contract to which the inbox registration belongs'),
});

export const unregisterInboxAgentSchemaOutput = registryInboxRequestOutputSchema;

export const unregisterInboxAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: unregisterInboxAgentSchemaInput,
	output: unregisterInboxAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof unregisterInboxAgentSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const smartContractAddress =
			input.smartContractAddress ??
			(input.network == Network.Mainnet
				? DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_MAINNET
				: DEFAULTS.PAYMENT_SMART_CONTRACT_ADDRESS_PREPROD);
		const paymentSource = await prisma.paymentSource.findUnique({
			where: {
				network_smartContractAddress: {
					network: input.network,
					smartContractAddress,
				},
				deletedAt: null,
			},
			include: {
				PaymentSourceConfig: { select: { rpcProviderApiKey: true } },
				HotWallets: {
					include: { Secret: { select: { encryptedMnemonic: true } } },
					where: { deletedAt: null },
				},
			},
		});
		if (paymentSource == null) {
			throw createHttpError(404, 'Network and Address combination not supported');
		}

		const blockfrost = getBlockfrostInstance(input.network, paymentSource.PaymentSourceConfig.rpcProviderApiKey);
		const { policyId } = await getRegistryScriptFromNetworkHandler(paymentSource);
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
		const registrationRequest = await prisma.inboxAgentRegistrationRequest.findUnique({
			where: {
				agentIdentifier: policyId + assetName,
			},
		});
		if (registrationRequest == null) {
			throw createHttpError(404, 'Registration not found');
		}
		if (!ctx.canAdmin && (registrationRequest.requestedById == null || registrationRequest.requestedById !== ctx.id)) {
			throw createHttpError(403, 'You are not authorized to deregister this inbox agent');
		}

		// Deregister is only valid for a settled on-chain asset that is not
		// mid-flight in another lifecycle action. Blocking the in-flight states
		// (Registration{Requested,Initiated}/Deregistration{Requested,Initiated})
		// stops a deregister from flipping a row the register/deregister
		// schedulers are already driving — which would let two services act on
		// the same asset and risk a double burn/mint. RegistrationFailed is
		// excluded because nothing was minted, and DeregistrationConfirmed
		// because the asset is already burned.
		const validStatesForDeregister: RegistrationState[] = [
			RegistrationState.RegistrationConfirmed,
			RegistrationState.DeregistrationFailed,
		];
		const result = await retryOnSerializationConflict(() =>
			prisma.$transaction(
				async (tx) => {
					// Re-read state INSIDE the serializable tx to close the TOCTOU window
					// between the findUnique above and this write.
					const current = await tx.inboxAgentRegistrationRequest.findUnique({
						where: { id: registrationRequest.id },
						select: { state: true },
					});
					if (current == null) {
						throw createHttpError(404, 'Registration not found');
					}
					if (!validStatesForDeregister.includes(current.state)) {
						throw createHttpError(
							409,
							`Inbox agent registration cannot be deregistered in its current state: ${current.state}`,
						);
					}
					return tx.inboxAgentRegistrationRequest.update({
						where: {
							id: registrationRequest.id,
							SmartContractWallet: {
								deletedAt: null,
							},
						},
						data: {
							state: RegistrationState.DeregistrationRequested,
							deregistrationHotWalletId: managedHolderWallet.id,
						},
						include: {
							SmartContractWallet: {
								select: { walletVkey: true, walletAddress: true },
							},
							RecipientWallet: {
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
						},
					});
				},
				{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
			),
		);

		return serializeInboxRegistryEntry(result);
	},
});
