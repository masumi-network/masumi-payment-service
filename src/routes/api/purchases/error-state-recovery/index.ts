import { Network, PurchasingAction, Prisma, TransactionStatus, OnChainState } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import { logger } from '@masumi/payment-core/logger';
import { ez } from 'express-zod-api';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { lovelaceToAdaNumberSafe } from '@/utils/lovelace';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { purchaseResponseSchema } from '..';
import { z } from '@masumi/payment-core/zod';
import { getPurchaseRetryAction } from '@/utils/shared/error-recovery';

export const purchaseErrorStateRecoverySchemaInput = z.object({
	blockchainIdentifier: z.string().min(1).max(8000).describe('The blockchain identifier of the purchase request'),
	network: z.nativeEnum(Network).describe('The network the transaction was made on'),
	updatedAt: ez.dateIn().describe('The time of the last update, to ensure you clear the correct error state'),
	retryPreviousAction: z
		.boolean()
		.optional()
		.describe('When true, retry the failed action. When false or omitted, only clear the error state.'),
});

export const purchaseErrorStateRecoverySchemaOutput = purchaseResponseSchema.omit({
	TransactionHistory: true,
	ActionHistory: true,
});

export const purchaseErrorStateRecoveryPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: purchaseErrorStateRecoverySchemaInput,
	output: purchaseErrorStateRecoverySchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof purchaseErrorStateRecoverySchemaInput>;
		ctx: AuthContext;
	}) => {
		// Check network permission
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		// Find purchase request
		const purchaseRequest = await prisma.purchaseRequest.findFirst({
			where: {
				blockchainIdentifier: input.blockchainIdentifier,
				updatedAt: input.updatedAt,
				PaymentSource: {
					network: input.network,
					deletedAt: null,
				},
			},
			include: {
				NextAction: true,
				CurrentTransaction: true,
				ActionHistory: {
					orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
					take: 1,
					select: {
						requestedAction: true,
					},
				},
				TransactionHistory: {
					orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
				},
			},
		});

		if (!purchaseRequest) {
			throw createHttpError(
				404,
				'Purchase request not found with the provided blockchain identifier or it was changed',
			);
		}
		assertWalletInScope(ctx.walletScopeIds, purchaseRequest.smartContractWalletId);
		if (purchaseRequest.requestedById !== ctx.id && !ctx.canAdmin) {
			throw createHttpError(403, 'You are not authorized to recover this purchase request');
		}
		// Validate that the request is in WaitingForManualAction with error
		if (purchaseRequest.NextAction.requestedAction !== PurchasingAction.WaitingForManualAction) {
			throw createHttpError(
				400,
				`Purchase request is not in WaitingForManualAction state. Current state: ${purchaseRequest.NextAction.requestedAction}`,
			);
		}

		if (!purchaseRequest.NextAction.errorType) {
			throw createHttpError(400, 'Purchase request is not in an error state. No error to clear.');
		}

		const previousAction = purchaseRequest.ActionHistory[0];
		const retryAction = previousAction ? getPurchaseRetryAction(previousAction.requestedAction) : null;
		if (input.retryPreviousAction && retryAction == null) {
			throw createHttpError(400, 'The immediately preceding purchase action is not retryable.');
		}

		if (
			!purchaseRequest.onChainState &&
			(!input.retryPreviousAction || retryAction !== PurchasingAction.FundsLockingRequested)
		) {
			throw createHttpError(
				400,
				'Purchase request is in its initial on-chain state. Only a failed funds-locking action can be retried.',
			);
		}

		const isCompletedState =
			purchaseRequest.onChainState != null &&
			(
				[OnChainState.Withdrawn, OnChainState.RefundWithdrawn, OnChainState.DisputedWithdrawn] as OnChainState[]
			).includes(purchaseRequest.onChainState);
		if (input.retryPreviousAction && isCompletedState) {
			throw createHttpError(400, 'The purchase is already completed and its previous action cannot be retried.');
		}

		// Find the most recent successful transaction (confirmed or pending).
		// A row without a txHash is never a valid target: the retried action
		// reads `CurrentTransaction.txHash` to locate its escrow UTxO and fails
		// with 'Transaction hash not found'. Such a row is also excluded from
		// `transactionsToFail` below (it is the selected one), so the request
		// could never leave the error state by retrying.
		// Priority 1: Most recent Confirmed transaction (fully successful)
		const confirmedTransactions = purchaseRequest.TransactionHistory.filter(
			(tx) => tx.status === TransactionStatus.Confirmed && tx.txHash != null,
		);
		const mostRecentConfirmedTransaction = confirmedTransactions.length > 0 ? confirmedTransactions[0] : undefined;

		// Priority 2: If no confirmed, get most recent Pending transaction (in progress)
		const pendingTransactions = purchaseRequest.TransactionHistory.filter(
			(tx) => tx.status === TransactionStatus.Pending && tx.txHash != null,
		);
		const mostRecentPendingTransaction = pendingTransactions.length > 0 ? pendingTransactions[0] : undefined;

		// Use the best available transaction
		const lastSuccessfulTransaction = mostRecentConfirmedTransaction ?? mostRecentPendingTransaction;

		const transactionsToFail = purchaseRequest.TransactionHistory.filter((tx) => {
			if (tx.status !== TransactionStatus.Pending) return false;

			if (lastSuccessfulTransaction && tx.id === lastSuccessfulTransaction.id) {
				return false;
			}

			if (!lastSuccessfulTransaction) return true;

			return new Date(tx.createdAt).getTime() >= new Date(lastSuccessfulTransaction.createdAt).getTime();
		});

		logger.info('Error state recovery initiated', {
			purchaseRequestId: purchaseRequest.id,
			blockchainIdentifier: input.blockchainIdentifier,
			lastSuccessfulTransactionId: lastSuccessfulTransaction?.id || null,
			lastSuccessfulTransactionStatus: lastSuccessfulTransaction?.status || null,
			transactionsToFailCount: transactionsToFail.length,
			transactionsToFailIds: transactionsToFail.map((tx) => tx.id),
			retryPreviousAction: input.retryPreviousAction === true,
			retryAction,
		});

		// Serializable + retry: this handler races concurrent tx-sync handlers
		// that may advance the same PurchaseRequest. Without Serializable
		// isolation, a concurrent state-machine update can win between this
		// route's pre-read and the in-transaction updates here.
		let newPurchase;
		try {
			newPurchase = await retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (tx) => {
							for (const transaction of transactionsToFail) {
								await tx.transaction.update({
									where: { id: transaction.id },
									data: { status: TransactionStatus.FailedViaManualReset },
								});
							}

							await tx.purchaseRequest.update({
								where: { id: purchaseRequest.id },
								data: { currentTransactionId: lastSuccessfulTransaction?.id || null },
							});

							return await tx.purchaseRequest.update({
								where: {
									id: purchaseRequest.id,
									nextActionId: purchaseRequest.nextActionId,
								},
								data: {
									ActionHistory: {
										connect: {
											id: purchaseRequest.nextActionId,
										},
									},
									NextAction: {
										create: {
											submittedTxHash: null,
											requestedAction: input.retryPreviousAction
												? retryAction!
												: isCompletedState
													? PurchasingAction.None
													: PurchasingAction.WaitingForExternalAction,
										},
									},
								},
								include: {
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
										},
									},
									PaidFunds: { select: { id: true, amount: true, unit: true } },
									PaymentSource: {
										select: {
											id: true,
											network: true,
											paymentSourceType: true,
											policyId: true,
											smartContractAddress: true,
										},
									},
									SellerWallet: { select: { id: true, walletVkey: true } },
									SmartContractWallet: {
										where: { deletedAt: null },
										select: { id: true, walletVkey: true, walletAddress: true },
									},
									WithdrawnForSeller: {
										select: { id: true, amount: true, unit: true },
									},
									WithdrawnForBuyer: {
										select: { id: true, amount: true, unit: true },
									},
								},
							});
						},
						{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
					),
				{ label: 'purchases-error-state-recovery' },
			);
		} catch (error) {
			if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
				throw createHttpError(409, 'Purchase state changed concurrently; retry against the new state');
			}
			throw error;
		}

		logger.info('Error state recovery completed successfully', {
			purchaseRequestId: purchaseRequest.id,
			failedTransactionsCount: transactionsToFail.length,
			retryPreviousAction: input.retryPreviousAction === true,
			retryAction,
		});

		const decoded = decodeBlockchainIdentifier(newPurchase.blockchainIdentifier);

		return {
			...newPurchase,
			...transformPurchaseGetTimestamps(newPurchase),
			...transformPurchaseGetAmounts(newPurchase),
			// safe: response schema is z.number() (ADA). lovelaceToAdaNumberSafe
			// throws if the lovelace value exceeds Number.MAX_SAFE_INTEGER.
			totalBuyerCardanoFees: lovelaceToAdaNumberSafe(newPurchase.totalBuyerCardanoFees),
			totalSellerCardanoFees: lovelaceToAdaNumberSafe(newPurchase.totalSellerCardanoFees),
			agentIdentifier: decoded?.agentIdentifier ?? null,
			CurrentTransaction: newPurchase.CurrentTransaction
				? {
						...newPurchase.CurrentTransaction,
						fees: newPurchase.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
		};
	},
});
