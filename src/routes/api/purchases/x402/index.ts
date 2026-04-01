import { z } from '@/utils/zod-openapi';
import { HotWalletType, PurchasingAction } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { BlockfrostProvider } from '@meshsdk/core';
import { logger } from '@/utils/logger';
import { validateHexString } from '@/utils/validator/hex';
import { handlePurchaseCreditInit } from '@/services/integrations';
import { HttpExistsError } from '@/utils/errors/http-exists-error';
import { recordBusinessEndpointError } from '@/utils/metrics';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
import { buildX402FundsLockingTransaction } from '@/services/purchases/x402-build/service';
import { createX402PurchaseSchemaInput, createX402PurchaseSchemaOutput } from './schemas';
import { CONSTANTS } from '@/utils/config';
import { resolvePurchaseCreationContext } from '../shared';

export { createX402PurchaseSchemaInput, createX402PurchaseSchemaOutput };

const purchaseRequestResponseInclude = {
	SellerWallet: { select: { id: true, walletVkey: true } },
	SmartContractWallet: {
		where: { deletedAt: null },
		select: { id: true, walletVkey: true, walletAddress: true },
	},
	PaymentSource: {
		select: {
			id: true,
			network: true,
			smartContractAddress: true,
			policyId: true,
		},
	},
	WithdrawnForBuyer: { select: { id: true, amount: true, unit: true } },
	WithdrawnForSeller: { select: { id: true, amount: true, unit: true } },
	PaidFunds: { select: { id: true, amount: true, unit: true } },
	NextAction: {
		select: {
			id: true,
			requestedAction: true,
			errorType: true,
			errorNote: true,
		},
	},
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
} satisfies Prisma.PurchaseRequestInclude;

type PurchaseRequestResponseRecord = Prisma.PurchaseRequestGetPayload<{
	include: typeof purchaseRequestResponseInclude;
}>;

type RecordedBusinessMetricError = Error & { businessEndpointErrorRecorded?: boolean };

function createRecordedBusinessHttpError(
	statusCode: number,
	message: string,
	attributes: Record<string, string>,
): Error {
	recordBusinessEndpointError('/api/v1/purchase/x402', 'POST', statusCode, message, attributes);
	const error = createHttpError(statusCode, message) as RecordedBusinessMetricError;
	error.businessEndpointErrorRecorded = true;
	return error;
}

async function getCoinsPerUtxoSize(blockchainProvider: BlockfrostProvider) {
	let coinsPerUtxoSize: number = CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE;
	try {
		const params = await blockchainProvider.fetchProtocolParameters();
		if (params.coinsPerUtxoSize != null) {
			coinsPerUtxoSize = params.coinsPerUtxoSize;
		}
	} catch (e) {
		logger.warn('Could not fetch protocol parameters, using fallback for min-UTXO calculation', {
			error: e,
		});
	}
	return coinsPerUtxoSize;
}

function serializeX402PurchaseResponse(
	purchaseRequest: PurchaseRequestResponseRecord,
	agentIdentifier: string,
	unsignedTxCbor: string,
	overrides?: {
		collateralReturnLovelace?: bigint;
	},
) {
	const timestamps = transformPurchaseGetTimestamps(purchaseRequest);
	const amounts = transformPurchaseGetAmounts(purchaseRequest);

	return {
		id: purchaseRequest.id,
		createdAt: purchaseRequest.createdAt,
		updatedAt: purchaseRequest.updatedAt,
		blockchainIdentifier: purchaseRequest.blockchainIdentifier,
		agentIdentifier,
		pricingType: purchaseRequest.pricingType,
		lastCheckedAt: purchaseRequest.lastCheckedAt,
		payByTime: timestamps.payByTime,
		submitResultTime: timestamps.submitResultTime,
		unlockTime: timestamps.unlockTime,
		externalDisputeUnlockTime: timestamps.externalDisputeUnlockTime,
		totalBuyerCardanoFees: Number(purchaseRequest.totalBuyerCardanoFees.toString()) / 1_000_000,
		totalSellerCardanoFees: Number(purchaseRequest.totalSellerCardanoFees.toString()) / 1_000_000,
		nextActionOrOnChainStateOrResultLastChangedAt: purchaseRequest.nextActionOrOnChainStateOrResultLastChangedAt,
		nextActionLastChangedAt: purchaseRequest.nextActionLastChangedAt,
		onChainStateOrResultLastChangedAt: purchaseRequest.onChainStateOrResultLastChangedAt,
		requestedById: purchaseRequest.requestedById,
		onChainState: purchaseRequest.onChainState,
		collateralReturnLovelace: overrides?.collateralReturnLovelace?.toString() ?? timestamps.collateralReturnLovelace,
		cooldownTime: timestamps.cooldownTime,
		cooldownTimeOtherParty: timestamps.cooldownTimeOtherParty,
		inputHash: purchaseRequest.inputHash,
		resultHash: purchaseRequest.resultHash,
		NextAction: {
			requestedAction: purchaseRequest.NextAction.requestedAction,
			errorType: purchaseRequest.NextAction.errorType,
			errorNote: purchaseRequest.NextAction.errorNote,
		},
		CurrentTransaction:
			purchaseRequest.CurrentTransaction != null
				? {
						id: purchaseRequest.CurrentTransaction.id,
						createdAt: purchaseRequest.CurrentTransaction.createdAt,
						updatedAt: purchaseRequest.CurrentTransaction.updatedAt,
						txHash: purchaseRequest.CurrentTransaction.txHash,
						status: purchaseRequest.CurrentTransaction.status,
						fees: purchaseRequest.CurrentTransaction.fees?.toString() ?? null,
						blockHeight: purchaseRequest.CurrentTransaction.blockHeight,
						blockTime: purchaseRequest.CurrentTransaction.blockTime,
						previousOnChainState: purchaseRequest.CurrentTransaction.previousOnChainState,
						newOnChainState: purchaseRequest.CurrentTransaction.newOnChainState,
						confirmations: purchaseRequest.CurrentTransaction.confirmations,
					}
				: null,
		PaidFunds: amounts.PaidFunds,
		WithdrawnForSeller: amounts.WithdrawnForSeller,
		WithdrawnForBuyer: amounts.WithdrawnForBuyer,
		PaymentSource: purchaseRequest.PaymentSource,
		SellerWallet: purchaseRequest.SellerWallet,
		SmartContractWallet: purchaseRequest.SmartContractWallet,
		metadata: purchaseRequest.metadata,
		unsignedTxCbor,
	};
}

async function throwExistingX402PurchaseError({
	existingPurchaseRequest,
	input,
	paymentSource,
}: {
	existingPurchaseRequest: PurchaseRequestResponseRecord;
	input: z.infer<typeof createX402PurchaseSchemaInput>;
	paymentSource: {
		smartContractAddress: string;
		PaymentSourceConfig: { rpcProviderApiKey: string };
	};
}): Promise<never> {
	let unsignedTxCbor = '';
	let collateralReturnLovelaceOverride: bigint | undefined;
	const canRebuildUnsignedTx =
		existingPurchaseRequest.NextAction.requestedAction === PurchasingAction.ExternalFundsLockingInitiated &&
		existingPurchaseRequest.buyerWalletAddress != null &&
		existingPurchaseRequest.buyerWalletAddress === input.buyerAddress &&
		existingPurchaseRequest.CurrentTransaction == null;

	if (canRebuildUnsignedTx) {
		try {
			const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
			const coinsPerUtxoSize = await getCoinsPerUtxoSize(blockchainProvider);

			const rebuiltTransaction = await buildX402FundsLockingTransaction({
				purchaseRequestId: existingPurchaseRequest.id,
				buyerAddress: input.buyerAddress,
				blockchainProvider,
				network: input.network,
				scriptAddress: paymentSource.smartContractAddress,
				coinsPerUtxoSize,
				persistState: false,
			});
			unsignedTxCbor = rebuiltTransaction.unsignedTxCbor;
			collateralReturnLovelaceOverride = rebuiltTransaction.collateralReturnLovelace;
		} catch (error) {
			logger.warn('Unable to rebuild unsigned x402 tx for existing purchase', {
				error,
				purchaseRequestId: existingPurchaseRequest.id,
			});
		}
	}

	throw new HttpExistsError(
		'Purchase exists',
		existingPurchaseRequest.id,
		serializeX402PurchaseResponse(existingPurchaseRequest, input.agentIdentifier, unsignedTxCbor, {
			collateralReturnLovelace: collateralReturnLovelaceOverride,
		}),
	);
}

export const createX402PurchasePost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: createX402PurchaseSchemaInput,
	output: createX402PurchaseSchemaOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof createX402PurchaseSchemaInput>; ctx: AuthContext }) => {
		const startTime = Date.now();
		try {
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

			const policyId = input.agentIdentifier.substring(0, 56);

			const paymentSource = await prisma.paymentSource.findFirst({
				where: { policyId, network: input.network, deletedAt: null },
				include: {
					PaymentSourceConfig: { select: { rpcProviderApiKey: true, rpcProvider: true } },
				},
			});

			const inputHash = input.inputHash;
			if (validateHexString(inputHash) == false) {
				throw createRecordedBusinessHttpError(400, 'Input hash is not a valid hex string', {
					network: input.network,
					field: 'inputHash',
					validation_type: 'invalid_hex_string',
				});
			}

			if (paymentSource == null) {
				throw createRecordedBusinessHttpError(404, 'No payment source found for agent identifiers policy id', {
					network: input.network,
					step: 'payment_source_lookup',
				});
			}

			// Idempotency: return existing purchase if already created
			const existingPurchaseRequest = await prisma.purchaseRequest.findFirst({
				where: {
					blockchainIdentifier: input.blockchainIdentifier,
					paymentSourceId: paymentSource.id,
				},
				include: purchaseRequestResponseInclude,
			});
			if (existingPurchaseRequest != null) {
				await throwExistingX402PurchaseError({
					existingPurchaseRequest,
					input,
					paymentSource,
				});
			}

			const wallets = await prisma.hotWallet.aggregate({
				where: { paymentSourceId: paymentSource.id, type: HotWalletType.Selling, deletedAt: null },
				_count: true,
			});
			if (wallets._count === 0) {
				throw createRecordedBusinessHttpError(404, 'No valid purchasing wallets found', {
					network: input.network,
					wallet_type: 'selling',
					step: 'wallet_lookup',
				});
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
			const blockchainProvider = new BlockfrostProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
			const coinsPerUtxoSize = await getCoinsPerUtxoSize(blockchainProvider);

			const builtTransaction = await buildX402FundsLockingTransaction({
				purchaseRequestData: {
					blockchainIdentifier: input.blockchainIdentifier,
					inputHash: input.inputHash,
					payByTime,
					submitResultTime,
					unlockTime,
					externalDisputeUnlockTime,
					sellerAddress,
					paidFunds: requestedCost,
				},
				buyerAddress: input.buyerAddress,
				blockchainProvider,
				network: input.network,
				scriptAddress: smartContractAddress,
				coinsPerUtxoSize,
				persistState: false,
			});

			// Create purchase request in DB (same as regular purchase)
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
				initialNextAction: PurchasingAction.ExternalFundsLockingInitiated,
				collateralReturnLovelace: builtTransaction.collateralReturnLovelace,
				buyerWalletAddress: input.buyerAddress,
				buyerWalletVkey: builtTransaction.buyerWalletVkey,
			});

			const updatedPurchaseRequest = await prisma.purchaseRequest.findUnique({
				where: { id: initialPurchaseRequest.id },
				include: purchaseRequestResponseInclude,
			});
			if (updatedPurchaseRequest == null) {
				throw createHttpError(500, 'Purchase request not found after x402 transaction build');
			}

			return serializeX402PurchaseResponse(
				updatedPurchaseRequest,
				input.agentIdentifier,
				builtTransaction.unsignedTxCbor,
			);
		} catch (error: unknown) {
			const errorInstance = error instanceof Error ? error : new Error(String(error));
			const wasBusinessMetricAlreadyRecorded =
				(errorInstance as RecordedBusinessMetricError).businessEndpointErrorRecorded === true;
			const statusCode =
				(errorInstance as { statusCode?: number; status?: number }).statusCode ||
				(errorInstance as { statusCode?: number; status?: number }).status ||
				500;
			if (!wasBusinessMetricAlreadyRecorded) {
				recordBusinessEndpointError('/api/v1/purchase/x402', 'POST', statusCode, errorInstance, {
					network: input.network,
					user_id: ctx.id,
					agent_identifier: input.agentIdentifier,
					duration: Date.now() - startTime,
					step: 'x402_purchase_processing',
				});
			}
			throw error;
		}
	},
});
