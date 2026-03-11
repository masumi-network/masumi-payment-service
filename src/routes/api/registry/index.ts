import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { HotWalletType, PaymentType, PricingType, RegistrationState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { getBlockfrostInstance, validateAssetsOnChain } from '@/utils/blockfrost';
import { buildWalletScopeFilter, assertHotWalletInScope } from '@/utils/shared/wallet-scope';
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
import { mapRegistryRequestToOutput, mapA2ARegistryRequestToOutput } from '@/routes/api/registry/utils';

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
				},
				SmartContractWallet: { deletedAt: null },
				...buildWalletScopeFilter(ctx.walletScopeIds),
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

			const sellingWallet = await prisma.hotWallet.findUnique({
				where: {
					walletVkey: input.sellingWalletVkey,
					type: HotWalletType.Selling,
					deletedAt: null,
					PaymentSource: {
						deletedAt: null,
						network: input.network,
					},
				},
				include: {
					PaymentSource: {
						include: {
							PaymentSourceConfig: {
								select: { rpcProviderApiKey: true },
							},
						},
					},
				},
			});
			if (sellingWallet == null) {
				recordBusinessEndpointError('/api/v1/registry', 'POST', 404, 'Network and Address combination not supported', {
					network: input.network,
					operation: 'register_agent',
					step: 'wallet_lookup',
					wallet_vkey: input.sellingWalletVkey,
				});
				throw createHttpError(404, 'Network and Address combination not supported');
			}
			assertHotWalletInScope(ctx.walletScopeIds, sellingWallet.id);

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
					paymentType:
						input.AgentPricing.pricingType == PricingType.Fixed ? PaymentType.None : PaymentType.Web3CardanoV1,
					authorContactEmail: input.Author.contactEmail,
					authorContactOther: input.Author.contactOther,
					authorOrganization: input.Author.organization,
					state: RegistrationState.RegistrationRequested,
					agentIdentifier: null,
					ExampleOutputs: {
						createMany: {
							data: input.ExampleOutputs.map((exampleOutput) => ({
								name: exampleOutput.name,
								url: exampleOutput.url,
								mimeType: exampleOutput.mimeType,
							})),
						},
					},
					SmartContractWallet: {
						connect: {
							id: sellingWallet.id,
						},
					},
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
					ExampleOutputs: {
						select: {
							name: true,
							url: true,
							mimeType: true,
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

			return mapRegistryRequestToOutput(result);
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
			const validStatesForDeletion: RegistrationState[] = [
				RegistrationState.RegistrationFailed,
				RegistrationState.DeregistrationConfirmed,
			];

			const registryRequest = await prisma.registryRequest.findUnique({
				where: { id: input.id },
			});

			if (registryRequest) {
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
					where: { id: registryRequest.id },
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
						ExampleOutputs: {
							select: { name: true, url: true, mimeType: true },
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

				return mapRegistryRequestToOutput(item);
			}

			const a2aRequest = await prisma.a2ARegistryRequest.findUnique({
				where: { id: input.id },
			});

			if (a2aRequest) {
				if (!validStatesForDeletion.includes(a2aRequest.state)) {
					recordBusinessEndpointError(
						'/api/v1/registry',
						'DELETE',
						400,
						`Agent registration cannot be deleted in its current state: ${a2aRequest.state}`,
						{
							registry_id: input.id,
							operation: 'delete_agent_registration',
							step: 'state_validation',
							current_state: a2aRequest.state,
							valid_states: validStatesForDeletion.join(', '),
						},
					);
					throw createHttpError(400, `Agent registration cannot be deleted in its current state: ${a2aRequest.state}`);
				}

				const item = await prisma.a2ARegistryRequest.delete({
					where: { id: a2aRequest.id },
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

				return mapA2ARegistryRequestToOutput(item);
			}

			recordBusinessEndpointError('/api/v1/registry', 'DELETE', 404, 'Agent Registration not found', {
				registry_id: input.id,
				operation: 'delete_agent_registration',
				step: 'registry_lookup',
			});
			throw createHttpError(404, 'Agent Registration not found');
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
