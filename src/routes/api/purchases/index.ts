import { z } from '@/utils/zod-openapi';
import { HotWalletType } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { validateHexString } from '@/utils/validator/hex';
import { handlePurchaseCreditInit } from '@/services/integrations';
import { HttpExistsError } from '@/utils/errors/http-exists-error';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { buildWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { resolvePurchaseCreationContext } from './shared';
import {
	createPurchaseInitSchemaInput,
	createPurchaseInitSchemaOutput,
	purchaseResponseSchema,
	queryPurchaseCountSchemaInput,
	queryPurchaseCountSchemaOutput,
	queryPurchaseRequestSchemaInput,
	queryPurchaseRequestSchemaOutput,
} from './schemas';
import { getPurchasesForQuery } from './queries';
import { serializePurchasesResponse } from './serializers';

export {
	createPurchaseInitSchemaInput,
	createPurchaseInitSchemaOutput,
	purchaseResponseSchema,
	queryPurchaseCountSchemaInput,
	queryPurchaseCountSchemaOutput,
	queryPurchaseRequestSchemaInput,
	queryPurchaseRequestSchemaOutput,
};

export const queryPurchaseRequestGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryPurchaseRequestSchemaInput,
	output: queryPurchaseRequestSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryPurchaseRequestSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const result = await getPurchasesForQuery(input, ctx.walletScopeIds);
		if (result == null) {
			throw createHttpError(404, 'Purchase not found');
		}
		return serializePurchasesResponse(result);
	},
});

export const queryPurchaseCountGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: queryPurchaseCountSchemaInput,
	output: queryPurchaseCountSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof queryPurchaseCountSchemaInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		const total = await prisma.purchaseRequest.count({
			where: {
				PaymentSource: {
					deletedAt: null,
					network: input.network,
					smartContractAddress: input.filterSmartContractAddress ?? undefined,
				},
				...buildWalletScopeFilter(ctx.walletScopeIds),
			},
		});

		return {
			total,
		};
	},
});

export const createPurchaseInitPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createPurchaseInitSchemaInput,
	output: createPurchaseInitSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createPurchaseInitSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);
			const existingPurchaseRequest = await prisma.purchaseRequest.findUnique({
				where: {
					blockchainIdentifier: input.blockchainIdentifier,
					PaymentSource: {
						deletedAt: null,
						network: input.network,
					},
				},
				include: {
					SellerWallet: { select: { id: true, walletVkey: true } },
					SmartContractWallet: {
						where: { deletedAt: null },
						select: { id: true, walletVkey: true, walletAddress: true },
					},
					WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
					WithdrawnForSeller: {
						select: { id: true, amount: true, unit: true },
					},
					PaidFunds: { select: { id: true, amount: true, unit: true } },
					NextAction: true,
					CurrentTransaction: {
						select: {
							id: true,
							createdAt: true,
							updatedAt: true,
							txHash: true,
							status: true,
							fees: true,
							blockHeight: true,
							blockTime: true,
							previousOnChainState: true,
							newOnChainState: true,
							confirmations: true,
							utxoCount: true,
							withdrawalCount: true,
							assetMintOrBurnCount: true,
							redeemerCount: true,
							validContract: true,
							outputAmount: true,
						},
					},
				},
			});
			if (existingPurchaseRequest != null) {
				throw new HttpExistsError('Purchase exists', existingPurchaseRequest.id, {
					...existingPurchaseRequest,
					totalBuyerCardanoFees: Number(existingPurchaseRequest.totalBuyerCardanoFees.toString()) / 1_000_000,
					totalSellerCardanoFees: Number(existingPurchaseRequest.totalSellerCardanoFees.toString()) / 1_000_000,
					CurrentTransaction: existingPurchaseRequest.CurrentTransaction
						? {
								id: existingPurchaseRequest.CurrentTransaction.id,
								createdAt: existingPurchaseRequest.CurrentTransaction.createdAt,
								updatedAt: existingPurchaseRequest.CurrentTransaction.updatedAt,
								txHash: existingPurchaseRequest.CurrentTransaction.txHash,
								status: existingPurchaseRequest.CurrentTransaction.status,
								fees: existingPurchaseRequest.CurrentTransaction.fees?.toString() ?? null,
								blockHeight: existingPurchaseRequest.CurrentTransaction.blockHeight,
								blockTime: existingPurchaseRequest.CurrentTransaction.blockTime,
								utxoCount: existingPurchaseRequest.CurrentTransaction.utxoCount,
								withdrawalCount: existingPurchaseRequest.CurrentTransaction.withdrawalCount,
								assetMintOrBurnCount: existingPurchaseRequest.CurrentTransaction.assetMintOrBurnCount,
								redeemerCount: existingPurchaseRequest.CurrentTransaction.redeemerCount,
								validContract: existingPurchaseRequest.CurrentTransaction.validContract,
								outputAmount: existingPurchaseRequest.CurrentTransaction.outputAmount,
							}
						: null,
					TransactionHistory: [],
					payByTime: existingPurchaseRequest.payByTime?.toString() ?? null,
					PaidFunds: (
						existingPurchaseRequest.PaidFunds as Array<{
							unit: string;
							amount: bigint;
						}>
					).map((amount) => ({
						...amount,
						amount: amount.amount.toString(),
					})),
					WithdrawnForSeller: (
						existingPurchaseRequest.WithdrawnForSeller as Array<{
							unit: string;
							amount: bigint;
						}>
					).map((amount) => ({
						...amount,
						amount: amount.amount.toString(),
					})),
					WithdrawnForBuyer: (
						existingPurchaseRequest.WithdrawnForBuyer as Array<{
							unit: string;
							amount: bigint;
						}>
					).map((amount) => ({
						...amount,
						amount: amount.amount.toString(),
					})),
					submitResultTime: existingPurchaseRequest.submitResultTime.toString(),
					unlockTime: existingPurchaseRequest.unlockTime.toString(),
					externalDisputeUnlockTime: existingPurchaseRequest.externalDisputeUnlockTime.toString(),
					cooldownTime: Number(existingPurchaseRequest.buyerCoolDownTime),
					cooldownTimeOtherParty: Number(existingPurchaseRequest.sellerCoolDownTime),
					collateralReturnLovelace: existingPurchaseRequest.collateralReturnLovelace?.toString() ?? null,
					metadata: existingPurchaseRequest.metadata,
					buyerCoolDownTime: existingPurchaseRequest.buyerCoolDownTime.toString(),
					sellerCoolDownTime: existingPurchaseRequest.sellerCoolDownTime.toString(),
				});
			}
			const policyId = input.agentIdentifier.substring(0, 56);

			const paymentSource = await prisma.paymentSource.findFirst({
				where: {
					policyId: policyId,
					network: input.network,
					deletedAt: null,
				},
				include: {
					PaymentSourceConfig: {
						select: { rpcProviderApiKey: true, rpcProvider: true },
					},
				},
			});
			const inputHash = input.inputHash;
			if (validateHexString(inputHash) == false) {
				recordBusinessEndpointError('/api/v1/purchase', 'POST', 400, 'Input hash is not a valid hex string', {
					network: input.network,
					field: 'inputHash',
					validation_type: 'invalid_hex_string',
				});
				throw createHttpError(400, 'Input hash is not a valid hex string');
			}

			if (paymentSource == null) {
				recordBusinessEndpointError(
					'/api/v1/purchase',
					'POST',
					404,
					'No payment source found for agent identifiers policy id',
					{
						network: input.network,
						policy_id: policyId,
						agent_identifier: input.agentIdentifier,
						step: 'payment_source_lookup',
					},
				);
				throw createHttpError(404, 'No payment source found for agent identifiers policy id');
			}

			const wallets = await prisma.hotWallet.aggregate({
				where: {
					paymentSourceId: paymentSource.id,
					type: HotWalletType.Purchasing,
					deletedAt: null,
				},
				_count: true,
			});
			if (wallets._count === 0) {
				recordBusinessEndpointError('/api/v1/purchase', 'POST', 404, 'No valid purchasing wallets found', {
					network: input.network,
					payment_source_id: paymentSource.id,
					wallet_type: 'purchasing',
					step: 'wallet_lookup',
				});
				throw createHttpError(404, 'No valid purchasing wallets found');
			}
			const {
				externalDisputeUnlockTime,
				payByTime,
				pricingType,
				requestedCost,
				sellerAddress,
				submitResultTime,
				unlockTime,
			} = await resolvePurchaseCreationContext({
				input,
				rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
			});
			const smartContractAddress = paymentSource.smartContractAddress;

			const initialPurchaseRequest = await handlePurchaseCreditInit({
				id: ctx.id,
				walletScopeIds: ctx.walletScopeIds,
				cost: requestedCost,
				metadata: input.metadata,
				network: input.network,
				blockchainIdentifier: input.blockchainIdentifier,
				contractAddress: smartContractAddress,
				sellerVkey: input.sellerVkey,
				sellerAddress,
				payByTime,
				submitResultTime,
				unlockTime,
				externalDisputeUnlockTime,
				inputHash: input.inputHash,
				pricingType,
			});

			return {
				...initialPurchaseRequest,
				...transformPurchaseGetTimestamps(initialPurchaseRequest),
				...transformPurchaseGetAmounts(initialPurchaseRequest),
				totalBuyerCardanoFees: 0,
				totalSellerCardanoFees: 0,
				agentIdentifier: input.agentIdentifier,
				CurrentTransaction: null,
			};
		} catch (error: unknown) {
			// Record the business-specific error with context
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			recordBusinessEndpointError('/api/v1/purchase', 'POST', statusCode, errorInstance, {
				network: input.network,
				user_id: ctx.id,
				agent_identifier: input.agentIdentifier,
				duration: Date.now() - startTime,
				step: 'purchase_processing',
			});

			throw error;
		}
	},
});
