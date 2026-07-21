import { Network, PaymentAction, Prisma, TransactionStatus, OnChainState } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { AuthContext, checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { logger } from '@/utils/logger';
import { ez } from 'express-zod-api';
import { paymentResponseSchema } from '..';
import { decodeBlockchainIdentifier } from '@/utils/generator/blockchain-identifier-generator';
import { transformPaymentGetTimestamps, transformPaymentGetAmounts } from '@/utils/shared/transformers';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import { getPaymentRetryAction, getPaymentRetryResultHash } from '@/utils/shared/error-recovery';
import { z } from '@/utils/zod-openapi';
import { selectRecoveryTransaction } from '@/routes/api/shared/recovery-transaction';

export const paymentErrorStateRecoverySchemaInput = z.object({
	blockchainIdentifier: z.string().min(1).describe('The blockchain identifier of the payment request'),
	network: z.nativeEnum(Network).describe('The network the transaction was made on'),
	updatedAt: ez.dateIn().describe('The time of the last update, to ensure you clear the correct error state'),
	retryPreviousAction: z
		.boolean()
		.optional()
		.describe('When true, retry the failed action. When false or omitted, only clear the error state.'),
});

export const paymentErrorStateRecoverySchemaOutput = paymentResponseSchema.omit({
	TransactionHistory: true,
	ActionHistory: true,
});

export const paymentErrorStateRecoveryPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: paymentErrorStateRecoverySchemaInput,
	output: paymentErrorStateRecoverySchemaOutput,
	handler: async ({
		input,
		ctx,
	}: {
		input: z.infer<typeof paymentErrorStateRecoverySchemaInput>;
		ctx: AuthContext;
	}) => {
		// Check network permission
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, input.network);

		// Find payment request
		const paymentRequest = await prisma.paymentRequest.findFirst({
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
					take: 2,
					select: {
						requestedAction: true,
						resultHash: true,
					},
				},
				TransactionHistory: {
					orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
				},
			},
		});

		if (!paymentRequest) {
			throw createHttpError(404, 'Payment request not found with the provided blockchain identifier or it was changed');
		}
		assertWalletInScope(ctx.walletScopeIds, paymentRequest.smartContractWalletId);

		if (!paymentRequest.onChainState) {
			throw createHttpError(
				400,
				'Payment request is in its initial on-chain state. Can not be recovered. Please start a new payment request.',
			);
		}

		// Validate that the request is in WaitingForManualAction with error
		if (paymentRequest.NextAction.requestedAction !== PaymentAction.WaitingForManualAction) {
			throw createHttpError(
				400,
				`Payment request is not in WaitingForManualAction state. Current state: ${paymentRequest.NextAction.requestedAction}`,
			);
		}

		if (!paymentRequest.NextAction.errorType) {
			throw createHttpError(400, 'Payment request is not in an error state. No error to clear.');
		}

		const previousAction = paymentRequest.ActionHistory[0];
		const actionBeforePrevious = paymentRequest.ActionHistory[1];
		const retryAction = previousAction ? getPaymentRetryAction(previousAction.requestedAction) : null;
		if (input.retryPreviousAction && retryAction == null) {
			throw createHttpError(400, 'The immediately preceding payment action is not retryable.');
		}

		const retryResultHash = getPaymentRetryResultHash(
			paymentRequest.NextAction.resultHash,
			previousAction,
			actionBeforePrevious,
		);
		if (input.retryPreviousAction && retryAction === PaymentAction.SubmitResultRequested && retryResultHash == null) {
			throw createHttpError(400, 'The failed submit-result action has no result hash to retry.');
		}

		const isCompletedState = (
			[OnChainState.Withdrawn, OnChainState.RefundWithdrawn, OnChainState.DisputedWithdrawn] as OnChainState[]
		).includes(paymentRequest.onChainState);
		if (input.retryPreviousAction && isCompletedState) {
			throw createHttpError(400, 'The payment is already completed and its previous action cannot be retried.');
		}

		// Selection lives in selectRecoveryTransaction so the hash-less-row rule
		// is unit-tested; see src/routes/api/shared/recovery-transaction.spec.ts
		const lastSuccessfulTransaction = selectRecoveryTransaction(paymentRequest.TransactionHistory);

		// When no candidate qualifies AND an escrow exists, the pointer stays
		// where it is (see below). In that case the row it points at must NOT be
		// failed here, or the request ends up pointing at a row this same
		// transaction marked FailedViaManualReset — reporting success while
		// leaving the retry to throw 'Transaction hash not found'.
		const willKeepCurrentPointer = lastSuccessfulTransaction == null && paymentRequest.onChainState != null;

		const transactionsToFail = paymentRequest.TransactionHistory.filter((tx) => {
			if (willKeepCurrentPointer && tx.id === paymentRequest.currentTransactionId) return false;
			if (tx.status !== TransactionStatus.Pending) return false;

			if (lastSuccessfulTransaction && tx.id === lastSuccessfulTransaction.id) {
				return false;
			}

			if (!lastSuccessfulTransaction) return true;

			return new Date(tx.createdAt).getTime() >= new Date(lastSuccessfulTransaction.createdAt).getTime();
		});

		logger.info('Error state recovery initiated', {
			paymentRequestId: paymentRequest.id,
			blockchainIdentifier: input.blockchainIdentifier,
			lastSuccessfulTransactionId: lastSuccessfulTransaction?.id || null,
			lastSuccessfulTransactionStatus: lastSuccessfulTransaction?.status || null,
			transactionsToFailCount: transactionsToFail.length,
			transactionsToFailIds: transactionsToFail.map((tx) => tx.id),
			retryPreviousAction: input.retryPreviousAction === true,
			retryAction,
		});

		const result = await prisma
			.$transaction(async (tx) => {
				for (const transaction of transactionsToFail) {
					await tx.transaction.update({
						where: { id: transaction.id },
						data: { status: TransactionStatus.FailedViaManualReset },
					});
				}

				// Repoint when we have a candidate. When we do NOT, the right move
				// depends on whether an escrow exists on chain yet:
				//
				//   onChainState != null — the pointer is the request's only link to
				//     its escrow transaction. Clearing it strands the request: the row
				//     stays Confirmed with its hash, but nothing references it, and
				//     every later retry fails with 'Transaction hash not found' until
				//     someone re-links it by hand. Leave it alone.
				//
				//   onChainState == null — pre-escrow (a funds-locking retry). There is
				//     no escrow link worth keeping, and batch-payments re-selects
				//     candidates with `CurrentTransaction: { is: null }`, so a row that
				//     keeps its rolled-back tx would never re-batch — the endpoint would
				//     return 200 and the request would stall forever. Clear it.
				if (lastSuccessfulTransaction != null) {
					await tx.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: { currentTransactionId: lastSuccessfulTransaction.id },
					});
				} else if (paymentRequest.onChainState == null) {
					await tx.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: { currentTransactionId: null },
					});
				}
				const updatedPaymentRequest = await tx.paymentRequest.update({
					where: {
						id: paymentRequest.id,
						nextActionId: paymentRequest.nextActionId,
					},
					data: {
						ActionHistory: {
							connect: {
								id: paymentRequest.nextActionId,
							},
						},
						NextAction: {
							create: {
								requestedAction: input.retryPreviousAction
									? retryAction!
									: isCompletedState
										? PaymentAction.None
										: PaymentAction.WaitingForExternalAction,
								submittedTxHash: null,
								...(input.retryPreviousAction && retryAction === PaymentAction.SubmitResultRequested
									? { resultHash: retryResultHash }
									: {}),
							},
						},
					},
					include: {
						BuyerWallet: { select: { id: true, walletVkey: true } },
						SmartContractWallet: {
							where: { deletedAt: null },
							select: { id: true, walletVkey: true, walletAddress: true },
						},
						RequestedFunds: { select: { id: true, amount: true, unit: true } },
						NextAction: {
							select: {
								id: true,
								requestedAction: true,
								errorType: true,
								errorNote: true,
								resultHash: true,
							},
						},
						PaymentSource: {
							select: {
								id: true,
								network: true,
								smartContractAddress: true,
								policyId: true,
							},
						},
						CurrentTransaction: {
							select: {
								id: true,
								createdAt: true,
								updatedAt: true,
								fees: true,
								blockHeight: true,
								blockTime: true,
								txHash: true,
								status: true,
								previousOnChainState: true,
								newOnChainState: true,
								confirmations: true,
							},
						},
						WithdrawnForSeller: {
							select: { id: true, amount: true, unit: true },
						},
						WithdrawnForBuyer: {
							select: { id: true, amount: true, unit: true },
						},
					},
				});
				return updatedPaymentRequest;
			})
			.catch((error: unknown) => {
				if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
					throw createHttpError(409, 'Payment state changed concurrently; retry against the new state');
				}
				throw error;
			});

		logger.info('Error state recovery completed successfully', {
			paymentRequestId: paymentRequest.id,
			failedTransactionsCount: transactionsToFail.length,
			retryPreviousAction: input.retryPreviousAction === true,
			retryAction,
		});
		const decoded = decodeBlockchainIdentifier(result.blockchainIdentifier);

		return {
			...result,
			...transformPaymentGetTimestamps(result),
			...transformPaymentGetAmounts(result),
			totalBuyerCardanoFees: Number(result.totalBuyerCardanoFees.toString()) / 1_000_000,
			totalSellerCardanoFees: Number(result.totalSellerCardanoFees.toString()) / 1_000_000,
			agentIdentifier: decoded?.agentIdentifier ?? null,
			CurrentTransaction: result.CurrentTransaction
				? {
						...result.CurrentTransaction,
						fees: result.CurrentTransaction.fees?.toString() ?? null,
					}
				: null,
		};
	},
});
