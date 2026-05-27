import {
	PaymentAction,
	PaymentSource,
	PaymentSourceType,
	PurchasingAction,
	OnChainState,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { CONFIG } from '@masumi/payment-core/config';
// TODO(v1-package-boundary): move db/retry to @masumi/payment-core
import { retryOnSerializationConflict } from '@/utils/db/retry';

import { Mutex } from 'async-mutex';
import { withJobLock } from '@/services/shared';

const mutex = new Mutex();

export async function handleAutomaticDecisions() {
	await withJobLock(mutex, 'automatic_decisions', async () => {
		try {
			const paymentSources = await prisma.paymentSource.findMany({
				where: {
					syncInProgress: false,
					deletedAt: null,
					paymentSourceType: PaymentSourceType.Web3CardanoV1,
				},
			});
			if (CONFIG.AUTO_WITHDRAW_PAYMENTS) {
				await handleInitializeAutoWithdrawPayments(paymentSources);
			}
			if (CONFIG.AUTO_WITHDRAW_REFUNDS) {
				await handleInitializeAutoWithdrawRefunds(paymentSources);
			}
		} catch (error) {
			logger.error(`Error handling automatic decisions`, { error: error });
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
							async (prisma) => {
								const paymentRequests = await prisma.paymentRequest.findMany({
									where: {
										paymentSourceId: paymentSource.id,
										NextAction: {
											requestedAction: PaymentAction.WaitingForExternalAction,
											errorType: null,
										},
										resultHash: { not: null },
										onChainState: OnChainState.ResultSubmitted,
										//10 minutes for blockchain time offset
										unlockTime: { lte: Date.now() - 1000 * 60 * 10 },
									},
								});
								logger.info('Found auto withdraw payment requests', {
									count: paymentRequests.length,
									paymentSourceId: paymentSource.id,
									paymentSourceType: paymentSource.paymentSourceType,
								});
								await Promise.all(
									paymentRequests.map(async (paymentRequest) => {
										try {
											await prisma.paymentRequest.update({
												where: { id: paymentRequest.id },
												data: {
													ActionHistory: {
														connect: {
															id: paymentRequest.nextActionId,
														},
													},
													NextAction: {
														create: {
															requestedAction: PaymentAction.WithdrawRequested,
														},
													},
												},
											});
										} catch (error) {
											logger.error(`Error initializing auto withdraw payments`, {
												paymentRequestId: paymentRequest.id,
												paymentSourceType: paymentSource.paymentSourceType,
												error: error,
											});
										}
									}),
								);
							},
							{ timeout: 30_000 },
						),
					{ label: 'v1-automatic-decisions-0' },
				);
			} catch (error) {
				logger.error(`Error initializing auto withdraw payments`, {
					paymentSourceId: paymentSource.id,
					paymentSourceType: paymentSource.paymentSourceType,
					error: error,
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
							async (prisma) => {
								const purchaseRequests = await prisma.purchaseRequest.findMany({
									where: {
										paymentSourceId: paymentSource.id,
										NextAction: {
											requestedAction: PurchasingAction.WaitingForExternalAction,
											errorType: null,
										},
										resultHash: null,
										onChainState: {
											in: [OnChainState.RefundRequested, OnChainState.FundsLocked],
										},
										//10 minutes for blockchain time offset
										submitResultTime: { lte: Date.now() - 1000 * 60 * 10 },
									},
								});
								logger.info('Found auto withdraw refund requests', {
									count: purchaseRequests.length,
									paymentSourceId: paymentSource.id,
									paymentSourceType: paymentSource.paymentSourceType,
								});
								await Promise.all(
									purchaseRequests.map(async (purchaseRequest) => {
										try {
											await prisma.purchaseRequest.update({
												where: { id: purchaseRequest.id },
												data: {
													ActionHistory: {
														connect: {
															id: purchaseRequest.nextActionId,
														},
													},
													NextAction: {
														create: {
															requestedAction: PurchasingAction.WithdrawRefundRequested,
														},
													},
												},
											});
										} catch (error) {
											logger.error(`Error initializing auto withdraw refunds`, {
												purchaseRequestId: purchaseRequest.id,
												paymentSourceType: paymentSource.paymentSourceType,
												error: error,
											});
										}
									}),
								);
							},
							{ timeout: 30_000 },
						),
					{ label: 'v1-automatic-decisions-1' },
				);
			} catch (error) {
				logger.error(`Error initializing auto withdraw refunds`, {
					paymentSourceId: paymentSource.id,
					paymentSourceType: paymentSource.paymentSourceType,
					error: error,
				});
			}
		}),
	);
}
