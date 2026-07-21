import { Network, PurchasingAction, Prisma, TransactionStatus, OnChainState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { ez } from 'express-zod-api';
import { transformPurchaseGetAmounts, transformPurchaseGetTimestamps } from '@/utils/shared/transformers';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import { purchaseResponseSchema } from '..';
import { getPurchaseRetryAction } from '@/utils/shared/error-recovery';
import { z } from '@/utils/zod-openapi';
import { selectRecoveryTransaction } from '@/routes/api/shared/recovery-transaction';

export const purchaseErrorStateRecoverySchemaInput = z.object({
	blockchainIdentifier: z.string().min(1).describe('The blockchain identifier of the purchase request'),
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

		// Selection lives in selectRecoveryTransaction so the hash-less-row rule
		// is unit-tested; see src/routes/api/shared/recovery-transaction.spec.ts
		const lastSuccessfulTransaction = selectRecoveryTransaction(purchaseRequest.TransactionHistory);

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

		const newPurchase = await prisma
			.$transaction(async (tx) => {
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
			})
			.catch((error: unknown) => {
				if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
					throw createHttpError(409, 'Purchase state changed concurrently; retry against the new state');
				}
				throw error;
			});

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
			totalBuyerCardanoFees: Number(newPurchase.totalBuyerCardanoFees.toString()) / 1_000_000,
			totalSellerCardanoFees: Number(newPurchase.totalSellerCardanoFees.toString()) / 1_000_000,
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
