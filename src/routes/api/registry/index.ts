import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { PaymentSourceType, PricingType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { DEFAULTS } from '@masumi/payment-core/config';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { recordBusinessEndpointError } from '@masumi/payment-core/metrics';
import { getBlockfrostInstance, validateAssetsOnChain } from '@/utils/blockfrost';
import { buildManagedHolderWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { normalizeRequestedRegistryFundingLovelace } from '@/services/registry/shared';
import { getDefaultSupportedPaymentSources } from '@masumi/payment-source-v2/services/registry/supported-payment-sources';
import { SupportedPaymentSourceChain, validateSupportedPaymentSourcesOrThrow } from '@/types/payment-source';
import {
	deleteAgentRegistrationSchemaInput,
	deleteAgentRegistrationSchemaOutput,
	FilterStatus,
	queryRegistryCountSchemaInput,
	queryRegistryCountSchemaOutput,
	queryRegistryRequestSchemaInput,
	queryRegistryRequestSchemaOutput,
	registerAgentSchemaInput,
	registerAgentSchemaOutput,
	registryRequestOutputSchema,
} from './schemas';
import { getRegistryEntriesForQuery } from './queries';
import { serializeRegistryEntriesResponse } from './serializers';
import { resolveScopedRecipientWalletOrThrow, resolveScopedSellingWalletOrThrow } from './shared';

export {
	deleteAgentRegistrationSchemaInput,
	deleteAgentRegistrationSchemaOutput,
	FilterStatus,
	queryRegistryCountSchemaInput,
	queryRegistryCountSchemaOutput,
	queryRegistryRequestSchemaInput,
	queryRegistryRequestSchemaOutput,
	registerAgentSchemaInput,
	registerAgentSchemaOutput,
	registryRequestOutputSchema,
};

export const queryRegistryRequestGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryRegistryRequestSchemaInput,
	output: queryRegistryRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryRegistryRequestSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
		const result = await getRegistryEntriesForQuery(input, ctx.walletScopeIds);

		return serializeRegistryEntriesResponse(result);
	},
});

export const queryRegistryCountGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryRegistryCountSchemaInput,
	output: queryRegistryCountSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryRegistryCountSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const total = await prisma.registryRequest.count({
			where: {
				PaymentSource: {
					network: input.network,
					deletedAt: null,
					smartContractAddress: input.filterSmartContractAddress ?? undefined,
					paymentSourceType: input.filterPaymentSourceType,
				},
				SmartContractWallet: { deletedAt: null },
				...buildManagedHolderWalletScopeFilter(ctx.walletScopeIds),
			},
		});

		return {
			total,
		};
	},
});

export const registerAgentPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: registerAgentSchemaInput,
	output: registerAgentSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof registerAgentSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

			const sellingWallet = await resolveScopedSellingWalletOrThrow({
				network: input.network,
				sellingWalletVkey: input.sellingWalletVkey,
				walletScopeIds: ctx.walletScopeIds,
				metricPath: '/api/v1/registry',
				operation: 'register_agent',
			});
			const recipientWallet = await resolveScopedRecipientWalletOrThrow({
				network: input.network,
				recipientWalletAddress: input.recipientWalletAddress,
				sellingWallet,
				walletScopeIds: ctx.walletScopeIds,
				metricPath: '/api/v1/registry',
				operation: 'register_agent',
			});
			const sendFundingLovelace = normalizeRequestedRegistryFundingLovelace(input.sendFundingLovelace);
			// Default-advertise the EXACT payment source the selling wallet lives
			// on. The previous default unconditionally pointed to a derived V2
			// contract address, which mis-advertises a V1 wallet as accepting V2
			// payments and breaks buyer-side dispatch.
			const supportedPaymentSources =
				input.supportedPaymentSources ??
				(sellingWallet.PaymentSource.paymentSourceType === PaymentSourceType.Web3CardanoV2
					? await getDefaultSupportedPaymentSources(input.network)
					: [
							{
								chain: SupportedPaymentSourceChain.Cardano,
								network: input.network,
								paymentSourceType: sellingWallet.PaymentSource.paymentSourceType,
								address: sellingWallet.PaymentSource.smartContractAddress,
							},
						]);
			try {
				validateSupportedPaymentSourcesOrThrow(supportedPaymentSources, input.network);
			} catch (error) {
				throw createHttpError(400, error instanceof Error ? error.message : String(error));
			}

			// Validate pricing assets exist on-chain
			if (input.AgentPricing.pricingType === PricingType.Fixed) {
				const blockfrost = getBlockfrostInstance(
					input.network,
					sellingWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
				);

				const assetUnits = input.AgentPricing.Pricing.map((pricing) => pricing.unit);
				const { valid: _validAssets, invalid: invalidAssets } = await validateAssetsOnChain(blockfrost, assetUnits);

				if (invalidAssets.length > 0) {
					const invalidAssetsMessage = invalidAssets.map((item) => `${item.asset} (${item.errorMessage})`).join(', ');
					recordBusinessEndpointError(
						'/api/v1/registry',
						'POST',
						400,
						`Invalid assets in pricing: ${invalidAssetsMessage}`,
						{
							network: input.network,
							operation: 'register_agent',
							step: 'asset_validation',
							invalid_assets: invalidAssets.map((item) => `${item.asset}: ${item.errorMessage}`).join('; '),
						},
					);
					throw createHttpError(400, `Invalid assets in pricing: ${invalidAssetsMessage}`);
				}
			}

			const result = await prisma.registryRequest.create({
				data: {
					name: input.name,
					description: input.description,
					apiBaseUrl: input.apiBaseUrl,
					capabilityName: input.Capability.name,
					capabilityVersion: input.Capability.version,
					other: input.Legal?.other,
					terms: input.Legal?.terms,
					privacyPolicy: input.Legal?.privacyPolicy,
					authorName: input.Author.name,
					authorContactEmail: input.Author.contactEmail,
					authorContactOther: input.Author.contactOther,
					authorOrganization: input.Author.organization,
					sendFundingLovelace,
					state: RegistrationState.RegistrationRequested,
					agentIdentifier: null,
					metadataVersion: DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION,
					ExampleOutputs: {
						createMany: {
							data: input.ExampleOutputs.map((exampleOutput) => ({
								name: exampleOutput.name,
								url: exampleOutput.url,
								mimeType: exampleOutput.mimeType,
							})),
						},
					},
					SupportedPaymentSources: {
						createMany: {
							data: supportedPaymentSources.map((source) => ({
								chain: source.chain,
								network: source.network,
								paymentSourceType: source.paymentSourceType,
								address: source.address,
							})),
						},
					},
					SmartContractWallet: {
						connect: {
							id: sellingWallet.id,
						},
					},
					RecipientWallet:
						recipientWallet != null
							? {
									connect: {
										id: recipientWallet.id,
									},
								}
							: undefined,
					PaymentSource: {
						connect: {
							id: sellingWallet.paymentSourceId,
						},
					},
					tags: input.Tags,
					Pricing: {
						create:
							input.AgentPricing.pricingType == PricingType.Fixed
								? {
										pricingType: input.AgentPricing.pricingType,
										FixedPricing: {
											create: {
												Amounts: {
													createMany: {
														data: input.AgentPricing.Pricing.map((price) => ({
															unit: price.unit.toLowerCase() == 'lovelace' ? '' : price.unit,
															amount: BigInt(price.amount),
														})),
													},
												},
											},
										},
									}
								: {
										pricingType: input.AgentPricing.pricingType,
									},
					},
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
					ExampleOutputs: {
						select: {
							name: true,
							url: true,
							mimeType: true,
						},
					},
					SupportedPaymentSources: {
						select: {
							chain: true,
							network: true,
							paymentSourceType: true,
							address: true,
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
				supportedPaymentSources: result.SupportedPaymentSources.length > 0 ? result.SupportedPaymentSources : null,
				Tags: result.tags,
				RecipientWallet: result.RecipientWallet,
				CurrentTransaction: result.CurrentTransaction
					? {
							...result.CurrentTransaction,
							fees: result.CurrentTransaction.fees?.toString() ?? null,
						}
					: null,
			};
		} catch (error: unknown) {
			// Record the business-specific error with context
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/registry', 'POST', statusCode, errorInstance, {
				network: input.network,
				user_id: ctx.id,
				agent_name: input.name,
				operation: 'register_agent',
				duration: Date.now() - startTime,
			});

			throw error;
		}
	},
});

export const deleteAgentRegistration = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteAgentRegistrationSchemaInput,
	output: deleteAgentRegistrationSchemaOutput,
	handler: async ({ input }) => {
		const startTime = Date.now();
		try {
			const registryRequest = await prisma.registryRequest.findUnique({
				where: {
					id: input.id,
				},
				include: {
					PaymentSource: {
						select: {
							id: true,
							network: true,
							policyId: true,
							smartContractAddress: true,
						},
					},
				},
			});

			if (!registryRequest) {
				recordBusinessEndpointError('/api/v1/registry', 'DELETE', 404, 'Agent Registration not found', {
					registry_id: input.id,
					operation: 'delete_agent_registration',
					step: 'registry_lookup',
				});
				throw createHttpError(404, 'Agent Registration not found');
			}

			const validStatesForDeletion: RegistrationState[] = [
				RegistrationState.RegistrationFailed,
				RegistrationState.DeregistrationConfirmed,
			];

			if (!validStatesForDeletion.includes(registryRequest.state)) {
				recordBusinessEndpointError(
					'/api/v1/registry',
					'DELETE',
					400,
					`Agent registration cannot be deleted in its current state: ${registryRequest.state}`,
					{
						registry_id: input.id,
						operation: 'delete_agent_registration',
						step: 'state_validation',
						current_state: registryRequest.state,
						valid_states: validStatesForDeletion.join(', '),
					},
				);
				throw createHttpError(
					400,
					`Agent registration cannot be deleted in its current state: ${registryRequest.state}`,
				);
			}

			const item = await prisma.registryRequest.delete({
				where: {
					id: registryRequest.id,
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
					ExampleOutputs: {
						select: { name: true, url: true, mimeType: true },
					},
					SupportedPaymentSources: {
						select: {
							chain: true,
							network: true,
							paymentSourceType: true,
							address: true,
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

			return {
				...item,
				Capability: {
					name: item.capabilityName,
					version: item.capabilityVersion,
				},
				Author: {
					name: item.authorName,
					contactEmail: item.authorContactEmail,
					contactOther: item.authorContactOther,
					organization: item.authorOrganization,
				},
				Legal: {
					privacyPolicy: item.privacyPolicy,
					terms: item.terms,
					other: item.other,
				},
				AgentPricing:
					item.Pricing.pricingType == PricingType.Fixed
						? {
								pricingType: PricingType.Fixed,
								Pricing:
									item.Pricing.FixedPricing?.Amounts.map((price) => ({
										unit: price.unit,
										amount: price.amount.toString(),
									})) ?? [],
							}
						: {
								pricingType: item.Pricing.pricingType,
							},
				sendFundingLovelace: item.sendFundingLovelace?.toString() ?? null,
				supportedPaymentSources: item.SupportedPaymentSources.length > 0 ? item.SupportedPaymentSources : null,
				Tags: item.tags,
				RecipientWallet: item.RecipientWallet,
				CurrentTransaction: item.CurrentTransaction
					? {
							...item.CurrentTransaction,
							fees: item.CurrentTransaction.fees?.toString() ?? null,
						}
					: null,
			};
		} catch (error: unknown) {
			// Record the business-specific error with context
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/registry', 'DELETE', statusCode, errorInstance, {
				registry_id: input.id,
				operation: 'delete_agent_registration',
				duration: Date.now() - startTime,
			});

			throw error;
		}
	},
});
