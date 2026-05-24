import {
	HotWalletType,
	RegistrationState,
	SwapStatus,
	TransactionStatus,
	PaymentAction,
	PaymentErrorType,
	PurchasingAction,
	PurchaseErrorType,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { logger } from '@masumi/payment-core/logger';
import { web3CardanoV1, web3CardanoV2 } from '@/services/payment-source-types';
import { CONFIG, DEFAULTS } from '@masumi/payment-core/config';
import { errorToString } from '@/utils/converter/error-string-convert';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import {
	findOrderOutputIndex,
	getSwapTxInclusion,
	SWAP_BACKGROUND_POLL_MIN_INTERVAL_MS,
	SWAP_CHAIN_SUBMIT_TIMEOUT_MS,
} from '@/services/integrations';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { markTransactionPhase2Failed } from '@/services/transactions/phase-2-failure';
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
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (prisma) => {
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
					},
					{ timeout: 30_000 },
				),
			{ label: 'wallet-timeouts-0' },
		);
	} catch (error) {
		logger.error('Error updating timed out payment requests', { error: error });
	}
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (prisma) => {
						const result = await prisma.purchaseRequest.findMany({
							where: {
								NextAction: {
									requestedAction: {
										in: [
											PurchasingAction.FundsLockingInitiated,
											PurchasingAction.WithdrawRefundInitiated,
											PurchasingAction.SetRefundRequestedInitiated,
											PurchasingAction.UnSetRefundRequestedInitiated,
											PurchasingAction.AuthorizeWithdrawalInitiated,
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
										purchaseRequest.SmartContractWallet?.pendingTransactionId ==
											purchaseRequest.currentTransactionId) ||
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
					},
					{ timeout: 30_000 },
				),
			{ label: 'wallet-timeouts-1' },
		);
	} catch (error) {
		logger.error('Error updating timed out purchasing requests', {
			error: error,
		});
	}
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (prisma) => {
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
										registryRequest.SmartContractWallet?.pendingTransactionId ==
											registryRequest.currentTransactionId) ||
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
					},
					{ timeout: 30_000 },
				),
			{ label: 'wallet-timeouts-2' },
		);
	} catch (error) {
		logger.error('Error updating timed out registry requests', {
			error: error,
		});
	}
	try {
		// Two recovery branches:
		//   1) wallet has a PendingTransaction whose `lastCheckedAt` is older than 1 min
		//      AND the wallet's outer `lockedAt` is either stale (past WALLET_LOCK_TIMEOUT_INTERVAL)
		//      or null. The `lockedAt` AND-guard is crucial: without it, a worker that
		//      JUST created a PendingTransaction (whose `lastCheckedAt` is seeded to now
		//      by `createPendingTransaction`) but is still inside its build/sign/submit
		//      window — possibly >1 min on slow Blockfrost / large batches — would be
		//      raced by this cron, which would disconnect the PendingTransaction and
		//      unlock the wallet while the worker is about to write the txHash. A
		//      second worker picking the wallet up would then collide on the same
		//      UTxOs.
		//   2) wallet has NO PendingTransaction but `lockedAt` is older than
		//      WALLET_LOCK_TIMEOUT_INTERVAL — an orphan lock from a `lockAndQueryX`
		//      caller that crashed/exited between committing the lock and creating
		//      its PendingTransaction. Without this branch the wallet stays locked
		//      forever (the relation filter requires `PendingTransaction != null`).
		const lockedHotWallets = await prisma.hotWallet.findMany({
			where: {
				deletedAt: null,
				OR: [
					{
						PendingTransaction: {
							//if the transaction has been checked in the last 30 seconds, we skip it
							lastCheckedAt: {
								lte: new Date(Date.now() - 1000 * 60 * 1),
							},
						},
						OR: [
							{
								lockedAt: {
									lt: new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL),
								},
							},
							{ lockedAt: null },
						],
					},
					{
						pendingTransactionId: null,
						lockedAt: {
							lt: new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL),
						},
					},
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
						// Orphan-lock branch: `lockedAt` is older than WALLET_LOCK_TIMEOUT_INTERVAL
						// and there's no PendingTransaction to poll. A previous caller (typically
						// inside `lockAndQueryX`) committed the lock then died before connecting
						// a PendingTransaction. Clear the lock so the next scheduler tick can
						// re-pick this wallet up.
						logger.warn(`Wallet ${wallet.id} locked without PendingTransaction past timeout — clearing orphan lock`);
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: { lockedAt: null },
						});
						if (wallet.type == HotWalletType.Selling) {
							unlockedSellingWalletIds.push(wallet.id);
						} else if (wallet.type == HotWalletType.Purchasing) {
							unlockedPurchasingWalletIds.push(wallet.id);
						}
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
					const provider = await createMeshProvider(blockfrostKey);
					const txInfo = await provider.fetchTxInfo(txHash);
					if (txInfo) {
						// Phase-2 detection: the tx landed on chain, but if the script
						// rejected (collateral consumed, expected outputs not produced),
						// no UTxO appears at the script address and tx-sync never fires.
						// Without this, the shared Transaction row keeps `txHash` set and
						// every dependent PaymentRequest / PurchaseRequest / RegistryRequest
						// stays in `*Initiated` forever. Mesh's `fetchTxInfo` does not
						// expose `valid_contract`, so go straight to Blockfrost.
						let validContract: boolean | null = null;
						try {
							const blockfrost = getBlockfrostInstance(wallet.PaymentSource.network, blockfrostKey);
							const txDetails = await blockfrost.txs(txHash);
							validContract = txDetails.valid_contract;
						} catch (err) {
							// Don't disconnect / unlock the wallet on transient Blockfrost
							// failures: once the PendingTransaction is detached we can no
							// longer re-poll this tx, so a flake here would permanently
							// strand dependents on a phase-2-failed tx. Bump `lastCheckedAt`
							// to throttle the retry to one per minute and bail out — next
							// tick re-fetches.
							//
							// Escalation: if the tx is older than WALLET_LOCK_TIMEOUT_INTERVAL
							// (operator-tunable, typically ~30-60 minutes) AND we still cannot
							// reach blockfrost, log at ERROR so on-call gets paged. We do NOT
							// auto-propagate phase-2 failure here — blockfrost being down does
							// not imply the tx failed; marking dependents as failed when really
							// we just couldn't verify would mis-route real funds. Operator
							// must intervene (verify off-platform, then manually advance state).
							const txAgeMs = Date.now() - wallet.PendingTransaction.createdAt.getTime();
							const escalate = txAgeMs > CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL;
							// Winston's `LeveledLogMethod` typing is positional (msg, meta) and
							// rejects `.call(thisArg, msg, meta)` as 3-arg under strict tsc, so
							// branch explicitly rather than passing the method by reference.
							const logMsg = `wallet-timeouts: failed to fetch valid_contract for ${txHash}, retrying next tick`;
							const logMeta = {
								error: errorToString(err),
								txAgeMs,
								escalated: escalate,
								note: escalate
									? 'tx older than WALLET_LOCK_TIMEOUT_INTERVAL while blockfrost still failing — operator action required to verify phase-2 outcome off-platform'
									: undefined,
							};
							if (escalate) {
								logger.error(logMsg, logMeta);
							} else {
								logger.warn(logMsg, logMeta);
							}
							await prisma.transaction.update({
								where: { id: wallet.PendingTransaction.id },
								data: { lastCheckedAt: new Date() },
							});
							return;
						}

						if (validContract === false) {
							logger.error(`Phase-2 failure detected for tx ${txHash} — propagating failure to dependents`, {
								txId: wallet.PendingTransaction.id,
							});
							// Wrap in retryOnSerializationConflict for symmetry with every other
							// $transaction site in the V2 batch services: the helper's internal
							// $transaction can lose to a concurrent writer (tx-sync confirmation
							// of a sibling request, the orphan-lock cleanup branch above, etc.),
							// and without retry the outer catch on line 620 would only log —
							// leaving the tx Pending and dependent requests stuck in `*Initiated`
							// until the next ~1-min cron tick re-discovered the same phase-2
							// failure.
							await retryOnSerializationConflict(
								() => markTransactionPhase2Failed(wallet.PendingTransaction!.id, txHash),
								{ label: 'wallet-timeouts-phase-2-propagate' },
							);
						}

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
					OR: [
						{
							lastCheckedAt: {
								lte: new Date(Date.now() - SWAP_BACKGROUND_POLL_MIN_INTERVAL_MS),
							},
						},
						{ lastCheckedAt: null },
					],
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
					const swapTx = wallet.PendingSwapTransaction;
					if (swapTx == null) {
						logger.error(`Wallet ${wallet.id} has no pending swap transaction when expected. Skipping...`);
						return;
					}
					const swapTxId = swapTx.id;
					const txHash = swapTx.txHash;
					const swapStatus = swapTx.swapStatus;
					const network = wallet.PaymentSource.network;
					const blockfrostKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
					const now = new Date();

					const isTimedOutByWalletLock =
						wallet.lockedAt != null &&
						new Date(wallet.lockedAt).getTime() < Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL;
					const elapsedSinceSwapCreated = Date.now() - swapTx.createdAt.getTime();

					let finalStatus: TransactionStatus | null = null;
					let finalSwapStatus: SwapStatus | null = null;
					let shouldUnlock = false;

					const persistSwapRow = async (extra: {
						status?: TransactionStatus;
						swapStatus?: SwapStatus;
						confirmations?: number | null;
						orderOutputIndex?: number;
					}) => {
						try {
							await prisma.swapTransaction.update({
								where: { id: swapTxId },
								data: {
									...(extra.status != null ? { status: extra.status } : {}),
									...(extra.swapStatus != null ? { swapStatus: extra.swapStatus } : {}),
									...(extra.confirmations !== undefined ? { confirmations: extra.confirmations } : {}),
									...(extra.orderOutputIndex !== undefined ? { orderOutputIndex: extra.orderOutputIndex } : {}),
									lastCheckedAt: now,
								},
							});
						} catch (swapTxError) {
							logger.error(`Failed to update swap transaction ${swapTxId}: ${errorToString(swapTxError)}`);
						}
					};

					if (txHash == null) {
						finalStatus = TransactionStatus.FailedViaTimeout;
						finalSwapStatus =
							swapStatus === SwapStatus.CancelPending ? SwapStatus.CancelSubmitTimeout : SwapStatus.OrderSubmitTimeout;
						shouldUnlock = true;
						await persistSwapRow({ status: finalStatus, swapStatus: finalSwapStatus });
					} else if (!blockfrostKey) {
						logger.error(`Wallet ${wallet.id} swap poll missing Blockfrost API key`);
						await persistSwapRow({});
					} else if (
						swapStatus === SwapStatus.OrderSubmitTimeout ||
						swapStatus === SwapStatus.CancelSubmitTimeout ||
						swapStatus === SwapStatus.Completed ||
						swapStatus === SwapStatus.CancelConfirmed
					) {
						shouldUnlock = true;
						await persistSwapRow({});
					} else if (swapStatus === SwapStatus.CancelPending || swapStatus === SwapStatus.OrderPending) {
						const blockfrost = getBlockfrostInstance(network, blockfrostKey);
						const txHashToCheck =
							swapStatus === SwapStatus.CancelPending && swapTx.cancelTxHash ? swapTx.cancelTxHash : txHash;

						try {
							const inclusion = await getSwapTxInclusion(blockfrost, txHashToCheck);

							if (inclusion.kind === 'not_found') {
								const lifecyclePending =
									swapStatus === SwapStatus.OrderPending || swapStatus === SwapStatus.CancelPending;
								if (lifecyclePending && elapsedSinceSwapCreated > SWAP_CHAIN_SUBMIT_TIMEOUT_MS) {
									finalSwapStatus =
										swapStatus === SwapStatus.CancelPending
											? SwapStatus.CancelSubmitTimeout
											: SwapStatus.OrderSubmitTimeout;
									finalStatus = TransactionStatus.FailedViaTimeout;
									shouldUnlock = true;
									await persistSwapRow({ status: finalStatus, swapStatus: finalSwapStatus });
								} else {
									await persistSwapRow({});
								}
								if (!shouldUnlock) {
									return;
								}
							} else if (inclusion.kind === 'unconfirmed') {
								await persistSwapRow({});
								return;
							} else {
								const confirmations = inclusion.confirmations;
								if (confirmations < CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
									await persistSwapRow({ confirmations });
									return;
								}

								if (swapStatus === SwapStatus.CancelPending) {
									finalSwapStatus = SwapStatus.CancelConfirmed;
									finalStatus = TransactionStatus.Confirmed;
									shouldUnlock = true;
									await persistSwapRow({
										status: finalStatus,
										swapStatus: finalSwapStatus,
										confirmations,
									});
								} else {
									let orderOutputIndex: number | null = null;
									try {
										orderOutputIndex = await findOrderOutputIndex(txHashToCheck, blockfrost, wallet.walletAddress);
									} catch (outputError) {
										logger.error('Failed to find order output index during swap poll', {
											txHash: txHashToCheck,
											walletId: wallet.id,
											error: outputError instanceof Error ? outputError.message : String(outputError),
										});
									}

									if (orderOutputIndex == null) {
										await persistSwapRow({ confirmations });
										return;
									}

									finalSwapStatus = SwapStatus.OrderConfirmed;
									finalStatus = TransactionStatus.Confirmed;
									shouldUnlock = true;
									await persistSwapRow({
										status: finalStatus,
										swapStatus: finalSwapStatus,
										confirmations,
										orderOutputIndex,
									});
								}
							}
						} catch (pollError) {
							logger.error(`Swap poll Blockfrost error for wallet ${wallet.id}: ${errorToString(pollError)}`);
							if (isTimedOutByWalletLock) {
								finalStatus = TransactionStatus.FailedViaTimeout;
								finalSwapStatus =
									swapStatus === SwapStatus.CancelPending
										? SwapStatus.CancelSubmitTimeout
										: SwapStatus.OrderSubmitTimeout;
								shouldUnlock = true;
								await persistSwapRow({ status: finalStatus, swapStatus: finalSwapStatus });
							} else {
								await persistSwapRow({});
							}
						}
					} else if (swapStatus === SwapStatus.OrderConfirmed) {
						shouldUnlock = true;
						await persistSwapRow({});
					} else {
						const blockfrost = getBlockfrostInstance(network, blockfrostKey);
						try {
							const inclusion = await getSwapTxInclusion(blockfrost, txHash);
							if (inclusion.kind === 'included') {
								if (inclusion.confirmations >= CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD) {
									finalStatus = TransactionStatus.Confirmed;
									finalSwapStatus = SwapStatus.Completed;
									shouldUnlock = true;
									await persistSwapRow({
										status: finalStatus,
										swapStatus: finalSwapStatus,
										confirmations: inclusion.confirmations,
									});
								} else {
									await persistSwapRow({ confirmations: inclusion.confirmations });
								}
							} else if (isTimedOutByWalletLock) {
								finalStatus = TransactionStatus.FailedViaTimeout;
								shouldUnlock = true;
								await persistSwapRow({ status: finalStatus });
							} else {
								await persistSwapRow({});
							}
						} catch (pollError) {
							logger.error(`Legacy swap poll error for wallet ${wallet.id}: ${errorToString(pollError)}`);
							if (isTimedOutByWalletLock) {
								finalStatus = TransactionStatus.FailedViaTimeout;
								shouldUnlock = true;
								await persistSwapRow({ status: finalStatus });
							} else {
								await persistSwapRow({});
							}
						}
					}

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
			for (const module of [web3CardanoV1, web3CardanoV2]) {
				try {
					await module.submitResult();
				} catch (error) {
					logger.error(`Error initiating submit result: ${errorToString(error)}`);
				}
				try {
					await module.authorizeRefund();
				} catch (error) {
					logger.error(`Error initiating refunds: ${errorToString(error)}`);
				}
				try {
					await module.collectOutstandingPayments();
				} catch (error) {
					logger.error(`Error initiating collect outstanding payments: ${errorToString(error)}`);
				}
				try {
					await module.registerAgent();
				} catch (error) {
					logger.error(`Error initiating register agent: ${errorToString(error)}`);
				}
				try {
					await module.registerInboxAgent();
				} catch (error) {
					logger.error(`Error initiating register inbox agent: ${errorToString(error)}`);
				}
				try {
					await module.deRegisterAgent();
				} catch (error) {
					logger.error(`Error initiating deregister agent: ${errorToString(error)}`);
				}
				try {
					await module.deRegisterInboxAgent();
				} catch (error) {
					logger.error(`Error initiating deregister inbox agent: ${errorToString(error)}`);
				}
			}
		}
		if (uniqueUnlockedPurchasingWalletIds.length > 0) {
			for (const module of [web3CardanoV1, web3CardanoV2]) {
				try {
					await module.collectRefund();
				} catch (error) {
					logger.error(`Error initiating collect refund: ${errorToString(error)}`);
				}
				try {
					await module.requestRefunds();
				} catch (error) {
					logger.error(`Error initiating request refund: ${errorToString(error)}`);
				}
				try {
					await module.batchLatestPaymentEntries();
				} catch (error) {
					logger.error(`Error initiating batch latest payment entries: ${errorToString(error)}`);
				}
			}
			try {
				await web3CardanoV1.cancelRefunds();
			} catch (error) {
				logger.error(`Error initiating cancel refund: ${errorToString(error)}`);
			}
			try {
				await web3CardanoV2.authorizeWithdrawals();
			} catch (error) {
				logger.error(`Error initiating authorize withdrawal: ${errorToString(error)}`);
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
