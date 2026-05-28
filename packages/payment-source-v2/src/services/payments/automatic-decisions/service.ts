import {
	OnChainState,
	PaymentAction,
	PaymentSource,
	PaymentSourceType,
	PurchasingAction,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { CONFIG } from '@masumi/payment-core/config';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { Mutex } from 'async-mutex';
import { withJobLock } from '@/services/shared';

const mutex = new Mutex();

export async function handleAutomaticDecisionsV2() {
	await withJobLock(mutex, 'automatic_decisions_v2', async () => {
		try {
			const paymentSources = await prisma.paymentSource.findMany({
				where: {
					syncInProgress: false,
					deletedAt: null,
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
				},
			});
			if (CONFIG.AUTO_WITHDRAW_PAYMENTS) {
				await handleInitializeAutoWithdrawPayments(paymentSources);
			}
			if (CONFIG.AUTO_WITHDRAW_REFUNDS) {
				await handleInitializeAutoWithdrawRefunds(paymentSources);
			}
		} catch (error) {
			logger.error(`Error in V2 automatic decisions`, { error });
		}
	});
}

async function handleInitializeAutoWithdrawPayments(paymentSources: PaymentSource[]) {
	await Promise.all(
		paymentSources.map(async (paymentSource) => {
			try {
				await retryOnSerializationConflict(
					() =>
						prisma.$transaction(
							async (tx) => {
								const paymentRequests = await tx.paymentRequest.findMany({
									where: {
										paymentSourceId: paymentSource.id,
										NextAction: {
											requestedAction: PaymentAction.WaitingForExternalAction,
											errorType: null,
										},
										resultHash: { not: null },
										OR: [
											{ onChainState: OnChainState.WithdrawAuthorized },
											{
												onChainState: OnChainState.ResultSubmitted,
												unlockTime: { lte: Date.now() - 1000 * 60 * 10 },
											},
										],
									},
								});
								logger.info('Found V2 auto withdraw payment requests', {
									count: paymentRequests.length,
									paymentSourceId: paymentSource.id,
								});
								await Promise.all(
									paymentRequests.map(async (paymentRequest) => {
										try {
											await tx.paymentRequest.update({
												where: { id: paymentRequest.id },
												data: {
													ActionHistory: { connect: { id: paymentRequest.nextActionId } },
													NextAction: { create: { requestedAction: PaymentAction.WithdrawRequested } },
												},
											});
										} catch (error) {
											logger.error(`Error initializing V2 auto withdraw payments`, {
												paymentRequestId: paymentRequest.id,
												error,
											});
										}
									}),
								);
							},
							{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
						),
					{ label: 'v2-automatic-decisions-0' },
				);
			} catch (error) {
				logger.error(`Error initializing V2 auto withdraw payments`, {
					paymentSourceId: paymentSource.id,
					error,
				});
			}
		}),
	);
}

async function handleInitializeAutoWithdrawRefunds(paymentSources: PaymentSource[]) {
	await Promise.all(
		paymentSources.map(async (paymentSource) => {
			try {
				await retryOnSerializationConflict(
					() =>
						prisma.$transaction(
							async (tx) => {
								const purchaseRequests = await tx.purchaseRequest.findMany({
									where: {
										paymentSourceId: paymentSource.id,
										NextAction: {
											requestedAction: PurchasingAction.WaitingForExternalAction,
											errorType: null,
										},
										resultHash: null,
										OR: [
											{ onChainState: OnChainState.RefundAuthorized },
											{
												onChainState: { in: [OnChainState.RefundRequested, OnChainState.FundsLocked] },
												submitResultTime: { lte: Date.now() - 1000 * 60 * 10 },
											},
										],
									},
								});
								logger.info('Found V2 auto withdraw refund requests', {
									count: purchaseRequests.length,
									paymentSourceId: paymentSource.id,
								});
								await Promise.all(
									purchaseRequests.map(async (purchaseRequest) => {
										try {
											await tx.purchaseRequest.update({
												where: { id: purchaseRequest.id },
												data: {
													ActionHistory: { connect: { id: purchaseRequest.nextActionId } },
													NextAction: { create: { requestedAction: PurchasingAction.WithdrawRefundRequested } },
												},
											});
										} catch (error) {
											logger.error(`Error initializing V2 auto withdraw refunds`, {
												purchaseRequestId: purchaseRequest.id,
												error,
											});
										}
									}),
								);
							},
							{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
						),
					{ label: 'v2-automatic-decisions-1' },
				);
			} catch (error) {
				logger.error(`Error initializing V2 auto withdraw refunds`, {
					paymentSourceId: paymentSource.id,
					error,
				});
			}
		}),
	);
}
