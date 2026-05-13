import {
	HotWalletType,
	TransactionStatus,
	PaymentAction,
	PaymentErrorType,
	PurchasingAction,
	PurchaseErrorType,
	RegistrationState,
} from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { collectOutstandingPaymentsV1, submitResultV1, authorizeRefundV1 } from '@/services/payments';
import { batchLatestPaymentEntriesV1, collectRefundV1, requestRefundsV1, cancelRefundsV1 } from '@/services/purchases';
import { registerAgentV1, deRegisterAgentV1 } from '@/services/registry';
import { registerInboxAgentV1, deRegisterInboxAgentV1 } from '@/services/registry-inbox';
import { CONFIG, DEFAULTS } from '@/utils/config';
import { errorToString } from '@/utils/converter/error-string-convert';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import {
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createNextPurchaseAction,
	updateCurrentTransactionStatus,
} from '@/services/shared';

const mutex = new Mutex();

export async function updateWalletTransactionHash() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}
	const unlockedSellingWalletIds: string[] = [];
	const unlockedPurchasingWalletIds: string[] = [];
	try {
		await prisma.$transaction(async (prisma) => {
			const result = await prisma.paymentRequest.findMany({
				where: {
					NextAction: {
						requestedAction: {
							in: [
								PaymentAction.WithdrawInitiated,
								PaymentAction.SubmitResultInitiated,
								PaymentAction.AuthorizeRefundInitiated,
							],
						},
					},
					OR: [
						{
							updatedAt: {
								lt: new Date(
									Date.now() -
										//15 minutes for timeouts, check every tx older than 1 minute
										CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
								),
							},
							CurrentTransaction: null,
						},
						{
							CurrentTransaction: {
								status: TransactionStatus.Pending,
								updatedAt: {
									lt: new Date(
										Date.now() -
											//15 minutes for timeouts, check every tx older than 1 minute
											DEFAULTS.TX_TIMEOUT_INTERVAL,
									),
								},
							},
						},
					],
				},
				include: { SmartContractWallet: { where: { deletedAt: null } } },
			});
			for (const paymentRequest of result) {
				if (paymentRequest.currentTransactionId == null) {
					if (
						paymentRequest.SmartContractWallet != null &&
						paymentRequest.SmartContractWallet.pendingTransactionId == null &&
						paymentRequest.SmartContractWallet.lockedAt &&
						new Date(paymentRequest.SmartContractWallet.lockedAt) <
							new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
					)
						unlockedSellingWalletIds.push(paymentRequest.SmartContractWallet?.id);

					await prisma.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							SmartContractWallet:
								paymentRequest.SmartContractWallet == null
									? undefined
									: {
											update: {
												//we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
												lockedAt:
													paymentRequest.SmartContractWallet.pendingTransactionId == null &&
													paymentRequest.SmartContractWallet.lockedAt &&
													new Date(paymentRequest.SmartContractWallet.lockedAt) <
														new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
														? null
														: undefined,
											},
										},
							...connectPreviousAction(paymentRequest.nextActionId),
							...createNextPaymentAction(PaymentAction.WaitingForExternalAction, {
								errorNote: 'Timeout when locking',
								errorType: PaymentErrorType.Unknown,
							}),
						},
					});
				} else {
					if (
						(paymentRequest.SmartContractWallet?.pendingTransactionId != null &&
							paymentRequest.SmartContractWallet?.pendingTransactionId == paymentRequest.currentTransactionId) ||
						(paymentRequest.SmartContractWallet?.lockedAt &&
							new Date(paymentRequest.SmartContractWallet.lockedAt) <
								new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
					)
						unlockedSellingWalletIds.push(paymentRequest.SmartContractWallet?.id);

					await prisma.paymentRequest.update({
						where: { id: paymentRequest.id },
						data: {
							SmartContractWallet:
								paymentRequest.SmartContractWallet == null
									? undefined
									: {
											update: {
												//we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
												lockedAt:
													(paymentRequest.SmartContractWallet?.pendingTransactionId != null &&
														paymentRequest.SmartContractWallet?.pendingTransactionId ==
															paymentRequest.currentTransactionId) ||
													(paymentRequest.SmartContractWallet?.lockedAt &&
														new Date(paymentRequest.SmartContractWallet.lockedAt) <
															new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
														? null
														: undefined,
												pendingTransactionId:
													(paymentRequest.SmartContractWallet?.pendingTransactionId != null &&
														paymentRequest.SmartContractWallet?.pendingTransactionId ==
															paymentRequest.currentTransactionId) ||
													(paymentRequest.SmartContractWallet?.lockedAt &&
														new Date(paymentRequest.SmartContractWallet.lockedAt) <
															new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
														? null
														: undefined,
											},
										},
							...updateCurrentTransactionStatus(TransactionStatus.FailedViaTimeout),
							...connectPreviousAction(paymentRequest.nextActionId),
							...createNextPaymentAction(PaymentAction.WaitingForExternalAction, {
								errorNote: 'Timeout when waiting for transaction',
								errorType: PaymentErrorType.Unknown,
							}),
						},
					});
				}
			}
		});
	} catch (error) {
		logger.error('Error updating timed out payment requests', { error: error });
	}
	try {
		await prisma.$transaction(async (prisma) => {
			const result = await prisma.purchaseRequest.findMany({
				where: {
					NextAction: {
						requestedAction: {
							in: [
								PurchasingAction.FundsLockingInitiated,
								PurchasingAction.WithdrawRefundInitiated,
								PurchasingAction.SetRefundRequestedInitiated,
								PurchasingAction.UnSetRefundRequestedInitiated,
							],
						},
					},
					OR: [
						{
							updatedAt: {
								lt: new Date(
									Date.now() -
										//15 minutes for timeouts, check every tx older than 1 minute
										CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
								),
							},
							CurrentTransaction: null,
						},
						{
							CurrentTransaction: {
								updatedAt: {
									lt: new Date(
										Date.now() -
											//15 minutes for timeouts, check every tx older than 1 minute
											DEFAULTS.TX_TIMEOUT_INTERVAL,
									),
								},
							},
						},
					],
				},
				include: { SmartContractWallet: { where: { deletedAt: null } }, NextAction: true },
			});
			for (const purchaseRequest of result) {
				if (purchaseRequest.currentTransactionId == null) {
					if (
						purchaseRequest.SmartContractWallet != null &&
						purchaseRequest.SmartContractWallet.pendingTransactionId == null &&
						purchaseRequest.SmartContractWallet.lockedAt &&
						new Date(purchaseRequest.SmartContractWallet.lockedAt) <
							new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
					)
						unlockedPurchasingWalletIds.push(purchaseRequest.SmartContractWallet?.id);

					await prisma.purchaseRequest.update({
						where: { id: purchaseRequest.id },
						data: {
							SmartContractWallet:
								purchaseRequest.SmartContractWallet == null
									? undefined
									: {
											update: {
												//we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
												lockedAt:
													purchaseRequest.SmartContractWallet.pendingTransactionId == null &&
													purchaseRequest.SmartContractWallet.lockedAt &&
													new Date(purchaseRequest.SmartContractWallet.lockedAt) <
														new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
														? null
														: undefined,
											},
										},
							...connectPreviousAction(purchaseRequest.nextActionId),
							...createNextPurchaseAction(PurchasingAction.WaitingForExternalAction, {
								errorNote: 'Timeout when locking',
								errorType: PurchaseErrorType.Unknown,
							}),
						},
					});
				} else {
					if (
						(purchaseRequest.SmartContractWallet?.pendingTransactionId != null &&
							purchaseRequest.SmartContractWallet?.pendingTransactionId == purchaseRequest.currentTransactionId) ||
						(purchaseRequest.SmartContractWallet?.lockedAt &&
							new Date(purchaseRequest.SmartContractWallet.lockedAt) <
								new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
					)
						unlockedPurchasingWalletIds.push(purchaseRequest.SmartContractWallet?.id);

					await prisma.purchaseRequest.update({
						where: { id: purchaseRequest.id },
						data: {
							SmartContractWallet:
								purchaseRequest.SmartContractWallet == null
									? undefined
									: {
											update: {
												//we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
												lockedAt:
													(purchaseRequest.SmartContractWallet?.pendingTransactionId != null &&
														purchaseRequest.SmartContractWallet?.pendingTransactionId ==
															purchaseRequest.currentTransactionId) ||
													(purchaseRequest.SmartContractWallet?.lockedAt &&
														new Date(purchaseRequest.SmartContractWallet.lockedAt) <
															new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
														? null
														: undefined,
												pendingTransactionId:
													(purchaseRequest.SmartContractWallet?.pendingTransactionId != null &&
														purchaseRequest.SmartContractWallet?.pendingTransactionId ==
															purchaseRequest.currentTransactionId) ||
													(purchaseRequest.SmartContractWallet?.lockedAt &&
														new Date(purchaseRequest.SmartContractWallet.lockedAt) <
															new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
														? null
														: undefined,
											},
										},
							...updateCurrentTransactionStatus(TransactionStatus.FailedViaTimeout),
							...connectPreviousAction(purchaseRequest.nextActionId),
							...createNextPurchaseAction(PurchasingAction.WaitingForExternalAction, {
								errorNote: 'Timeout when waiting for transaction',
								errorType: PurchaseErrorType.Unknown,
							}),
						},
					});
				}
			}
		});
	} catch (error) {
		logger.error('Error updating timed out purchasing requests', {
			error: error,
		});
	}
	try {
		await prisma.$transaction(async (prisma) => {
			const result = await prisma.registryRequest.findMany({
				where: {
					state: {
						in: [RegistrationState.RegistrationInitiated, RegistrationState.DeregistrationInitiated],
					},
					SmartContractWallet: { deletedAt: null },
					OR: [
						{
							updatedAt: {
								lt: new Date(
									Date.now() -
										//15 minutes for timeouts, check every tx older than 1 minute
										CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
								),
							},
							CurrentTransaction: null,
						},
						{
							CurrentTransaction: {
								updatedAt: {
									lt: new Date(
										Date.now() -
											//15 minutes for timeouts, check every tx older than 1 minute
											DEFAULTS.TX_TIMEOUT_INTERVAL,
									),
								},
							},
						},
					],
				},
				include: { SmartContractWallet: true },
			});

			for (const registryRequest of result) {
				if (registryRequest.currentTransactionId == null) {
					if (
						registryRequest.SmartContractWallet != null &&
						registryRequest.SmartContractWallet.pendingTransactionId == null &&
						registryRequest.SmartContractWallet.lockedAt &&
						new Date(registryRequest.SmartContractWallet.lockedAt) <
							new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
					)
						unlockedSellingWalletIds.push(registryRequest.SmartContractWallet?.id);

					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							SmartContractWallet:
								registryRequest.SmartContractWallet == null
									? undefined
									: {
											update: {
												//we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
												lockedAt:
													registryRequest.SmartContractWallet.pendingTransactionId == null &&
													registryRequest.SmartContractWallet.lockedAt &&
													new Date(registryRequest.SmartContractWallet.lockedAt) <
														new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
														? null
														: undefined,
											},
										},
							state:
								registryRequest.state == RegistrationState.RegistrationInitiated
									? RegistrationState.RegistrationFailed
									: RegistrationState.DeregistrationFailed,
							error: 'Timeout, force unlocked',
						},
					});
				} else {
					if (
						(registryRequest.SmartContractWallet?.pendingTransactionId != null &&
							registryRequest.SmartContractWallet?.pendingTransactionId == registryRequest.currentTransactionId) ||
						(registryRequest.SmartContractWallet?.lockedAt &&
							new Date(registryRequest.SmartContractWallet.lockedAt) <
								new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
					)
						unlockedSellingWalletIds.push(registryRequest.SmartContractWallet?.id);

					await prisma.registryRequest.update({
						where: { id: registryRequest.id },
						data: {
							SmartContractWallet:
								registryRequest.SmartContractWallet == null
									? undefined
									: {
											update: {
												//we expect there not to be a pending transaction. Otherwise we do not unlock the wallet
												lockedAt:
													(registryRequest.SmartContractWallet?.pendingTransactionId != null &&
														registryRequest.SmartContractWallet?.pendingTransactionId ==
															registryRequest.currentTransactionId) ||
													(registryRequest.SmartContractWallet?.lockedAt &&
														new Date(registryRequest.SmartContractWallet.lockedAt) <
															new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
														? null
														: undefined,
												pendingTransactionId:
													(registryRequest.SmartContractWallet?.pendingTransactionId != null &&
														registryRequest.SmartContractWallet?.pendingTransactionId ==
															registryRequest.currentTransactionId) ||
													(registryRequest.SmartContractWallet?.lockedAt &&
														new Date(registryRequest.SmartContractWallet.lockedAt) <
															new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL))
														? null
														: undefined,
											},
										},
							...updateCurrentTransactionStatus(TransactionStatus.FailedViaTimeout),
							state:
								registryRequest.state == RegistrationState.RegistrationInitiated
									? RegistrationState.RegistrationFailed
									: RegistrationState.DeregistrationFailed,
						},
					});
				}
			}
		});
	} catch (error) {
		logger.error('Error updating timed out registry requests', {
			error: error,
		});
	}
	try {
		const lockedHotWallets = await prisma.hotWallet.findMany({
			where: {
				PendingTransaction: {
					//if the transaction has been checked in the last 30 seconds, we skip it
					lastCheckedAt: {
						lte: new Date(Date.now() - 1000 * 60 * 1),
					},
				},
				deletedAt: null,
				OR: [
					{
						lockedAt: {
							lt: new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL),
						},
					},
					{ lockedAt: null },
				],
			},
			include: {
				PendingTransaction: true,
				PaymentSource: {
					include: { PaymentSourceConfig: true },
				},
			},
		});

		await Promise.allSettled(
			lockedHotWallets.map(async (wallet) => {
				try {
					if (wallet.PendingTransaction == null) {
						logger.error(`Wallet ${wallet.id} has no pending transaction when expected. Skipping...`);
						return;
					}
					const txHash = wallet.PendingTransaction.txHash;
					if (txHash == null) {
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: {
								PendingTransaction: { disconnect: true },
								lockedAt: null,
							},
						});
						if (wallet.type == HotWalletType.Selling) {
							unlockedSellingWalletIds.push(wallet.id);
						} else if (wallet.type == HotWalletType.Purchasing) {
							unlockedPurchasingWalletIds.push(wallet.id);
						}
						return;
					}

					const blockfrostKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
					const provider = createMeshProvider(blockfrostKey);
					const txInfo = await provider.fetchTxInfo(txHash);
					if (txInfo) {
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: {
								PendingTransaction: { disconnect: true },
								lockedAt: null,
							},
						});
						if (wallet.type == HotWalletType.Selling) {
							unlockedSellingWalletIds.push(wallet.id);
						} else if (wallet.type == HotWalletType.Purchasing) {
							unlockedPurchasingWalletIds.push(wallet.id);
						}
					} else {
						await prisma.transaction.update({
							where: { id: wallet.PendingTransaction.id },
							data: { lastCheckedAt: new Date() },
						});
					}
				} catch (error) {
					logger.error(`Error updating wallet transaction hash: ${errorToString(error)}`);
				}
			}),
		);

		// Handle wallets with pending swap transactions
		const swapLockedWallets = await prisma.hotWallet.findMany({
			where: {
				PendingSwapTransaction: {
					OR: [{ lastCheckedAt: { lte: new Date(Date.now() - 1000 * 60 * 1) } }, { lastCheckedAt: null }],
				},
				deletedAt: null,
			},
			include: {
				PendingSwapTransaction: true,
				PaymentSource: {
					include: { PaymentSourceConfig: true },
				},
			},
		});

		await Promise.allSettled(
			swapLockedWallets.map(async (wallet) => {
				try {
					if (wallet.PendingSwapTransaction == null) {
						logger.error(`Wallet ${wallet.id} has no pending swap transaction when expected. Skipping...`);
						return;
					}
					const swapTxId = wallet.PendingSwapTransaction.id;
					const txHash = wallet.PendingSwapTransaction.txHash;
					const isTimedOut =
						wallet.lockedAt && new Date(wallet.lockedAt) < new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL);

					// Determine swap tx final status
					let finalStatus: TransactionStatus | null = null;
					let shouldUnlock = false;

					if (txHash == null) {
						finalStatus = TransactionStatus.FailedViaTimeout;
						shouldUnlock = true;
					} else {
						const blockfrostKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
						const provider = createMeshProvider(blockfrostKey);
						try {
							const txInfo = await provider.fetchTxInfo(txHash);
							if (txInfo) {
								finalStatus = TransactionStatus.Confirmed;
								shouldUnlock = true;
							} else if (isTimedOut) {
								finalStatus = TransactionStatus.FailedViaTimeout;
								shouldUnlock = true;
							}
						} catch {
							// Blockfrost error (e.g. 404) — tx not found on-chain yet
							if (isTimedOut) {
								finalStatus = TransactionStatus.FailedViaTimeout;
								shouldUnlock = true;
							}
						}
					}

					// Update swap transaction status (best effort)
					try {
						await prisma.swapTransaction.update({
							where: { id: swapTxId },
							data: {
								...(finalStatus ? { status: finalStatus } : {}),
								lastCheckedAt: new Date(),
							},
						});
					} catch (swapTxError) {
						logger.error(`Failed to update swap transaction ${swapTxId}: ${errorToString(swapTxError)}`);
					}

					// Always unlock the wallet if needed — even if swap tx update failed
					if (shouldUnlock) {
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: { pendingSwapTransactionId: null, lockedAt: null },
						});
					}
				} catch (error) {
					logger.error(`Error updating swap wallet transaction hash: ${errorToString(error)}`);
				}
			}),
		);

		const timedOutLockedHotWallets = await prisma.hotWallet.findMany({
			where: {
				lockedAt: {
					lt: new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL),
				},
				deletedAt: null,
				PendingTransaction: null,
				PendingSwapTransaction: null,
			},
			include: {
				PaymentSource: { include: { PaymentSourceConfig: true } },
			},
		});
		await Promise.allSettled(
			timedOutLockedHotWallets.map(async (wallet) => {
				try {
					await prisma.hotWallet.update({
						where: { id: wallet.id, deletedAt: null },
						data: {
							lockedAt: null,
						},
					});

					if (wallet.type == HotWalletType.Selling) {
						unlockedSellingWalletIds.push(wallet.id);
					} else if (wallet.type == HotWalletType.Purchasing) {
						unlockedPurchasingWalletIds.push(wallet.id);
					}
				} catch (error) {
					logger.error(`Error updating timed out wallet: ${errorToString(error)}`);
				}
			}),
		);
		const uniqueUnlockedSellingWalletIds = [...new Set(unlockedSellingWalletIds)].filter((id) => id != null);
		const uniqueUnlockedPurchasingWalletIds = [...new Set(unlockedPurchasingWalletIds)].filter((id) => id != null);
		//TODO: reset initialized actions
		if (uniqueUnlockedSellingWalletIds.length > 0) {
			try {
				await submitResultV1();
			} catch (error) {
				logger.error(`Error initiating submit result: ${errorToString(error)}`);
			}
			try {
				await authorizeRefundV1();
			} catch (error) {
				logger.error(`Error initiating refunds: ${errorToString(error)}`);
			}
			try {
				await collectOutstandingPaymentsV1();
			} catch (error) {
				logger.error(`Error initiating collect outstanding payments: ${errorToString(error)}`);
			}
			try {
				await registerAgentV1();
			} catch (error) {
				logger.error(`Error initiating register agent: ${errorToString(error)}`);
			}
			try {
				await registerInboxAgentV1();
			} catch (error) {
				logger.error(`Error initiating register inbox agent: ${errorToString(error)}`);
			}
			try {
				await deRegisterAgentV1();
			} catch (error) {
				logger.error(`Error initiating deregister agent: ${errorToString(error)}`);
			}
			try {
				await deRegisterInboxAgentV1();
			} catch (error) {
				logger.error(`Error initiating deregister inbox agent: ${errorToString(error)}`);
			}
			try {
				await authorizeRefundV1();
			} catch (error) {
				logger.error(`Error initiating authorize refund: ${errorToString(error)}`);
			}
		}
		if (uniqueUnlockedPurchasingWalletIds.length > 0) {
			try {
				await collectRefundV1();
			} catch (error) {
				logger.error(`Error initiating collect refund: ${errorToString(error)}`);
			}
			try {
				await requestRefundsV1();
			} catch (error) {
				logger.error(`Error initiating request refund: ${errorToString(error)}`);
			}
			try {
				await cancelRefundsV1();
			} catch (error) {
				logger.error(`Error initiating cancel refund: ${errorToString(error)}`);
			}
			try {
				await batchLatestPaymentEntriesV1();
			} catch (error) {
				logger.error(`Error initiating batch latest payment entries: ${errorToString(error)}`);
			}
		}
		try {
			const errorHotWallets = await prisma.hotWallet.findMany({
				where: {
					PendingTransaction: { isNot: null },
					lockedAt: null,
					deletedAt: null,
				},
				include: { PendingTransaction: true },
			});
			for (const hotWallet of errorHotWallets) {
				logger.error(
					`Hot wallet ${hotWallet.id} was in an invalid locked state, Pending transaction is not null, wallet is not locked (this is likely a bug please report it with the following transaction hash): ${hotWallet.PendingTransaction?.txHash} ; transaction id: ${hotWallet.PendingTransaction?.id}`,
				);
				await prisma.hotWallet.update({
					where: { id: hotWallet.id, deletedAt: null },
					data: {
						lockedAt: null,
						PendingTransaction: { disconnect: true },
					},
				});
			}
		} catch (error) {
			logger.error(`Error updating wallet transaction hash`, { error: error });
		}
		try {
			const errorSwapHotWallets = await prisma.hotWallet.findMany({
				where: {
					PendingSwapTransaction: { isNot: null },
					lockedAt: null,
					deletedAt: null,
				},
				include: { PendingSwapTransaction: true },
			});
			for (const hotWallet of errorSwapHotWallets) {
				logger.error(
					`Hot wallet ${hotWallet.id} was in an invalid locked state for swap: ${hotWallet.PendingSwapTransaction?.txHash}`,
				);
				if (hotWallet.pendingSwapTransactionId) {
					try {
						await prisma.swapTransaction.update({
							where: { id: hotWallet.pendingSwapTransactionId },
							data: { status: TransactionStatus.FailedViaTimeout, lastCheckedAt: new Date() },
						});
					} catch (swapTxError) {
						logger.error(
							`Failed to update swap transaction ${hotWallet.pendingSwapTransactionId}: ${errorToString(swapTxError)}`,
						);
					}
				}
				await prisma.hotWallet.update({
					where: { id: hotWallet.id, deletedAt: null },
					data: { lockedAt: null, pendingSwapTransactionId: null },
				});
			}
		} catch (error) {
			logger.error(`Error updating swap wallet transaction hash`, { error: error });
		}
	} catch (error) {
		logger.error(`Error updating wallet transaction hash`, { error: error });
	} finally {
		release();
	}
}
