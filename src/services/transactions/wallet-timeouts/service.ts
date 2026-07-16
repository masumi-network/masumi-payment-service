import {
	HotWalletType,
	PaymentSourceType,
	RegistrationState,
	SwapStatus,
	TransactionStatus,
	PaymentAction,
	PaymentErrorType,
	PurchasingAction,
	PurchaseErrorType,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { web3CardanoV1, web3CardanoV2 } from '@/services/payment-source-types';
import { CONFIG, DEFAULTS } from '@masumi/payment-core/config';
import { errorToString } from '@masumi/payment-core/error-string-convert';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import {
	findOrderOutputIndex,
	getSwapTxInclusion,
	SWAP_BACKGROUND_POLL_MIN_INTERVAL_MS,
	SWAP_CHAIN_SUBMIT_TIMEOUT_MS,
} from '@/services/integrations';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { markTransactionPhase2Failed } from '@/services/transactions/phase-2-failure';
import { reconcileOne, type ReconcileCandidate } from '@/services/transactions/funding-reconciliation';
import {
	connectPreviousAction,
	createMeshProvider,
	createNextPaymentAction,
	createNextPurchaseAction,
	updateCurrentTransactionStatus,
} from '@/services/shared';
import { classifyUnseenPendingTx } from './dead-tx';

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
	// Track which payment source types had wallets unlocked so we only kick
	// the matching scheduler modules below. If type is unknown for any
	// pushed wallet, both flags are set (conservative — preserve old behavior).
	let unlockedV1 = false;
	let unlockedV2 = false;
	const markUnlockedByType = (type: PaymentSourceType | null | undefined) => {
		if (type === PaymentSourceType.Web3CardanoV1) {
			unlockedV1 = true;
		} else if (type === PaymentSourceType.Web3CardanoV2) {
			unlockedV2 = true;
		} else {
			// Unknown / missing type — fall back to running both module sets so
			// we never skip work we should have done.
			unlockedV1 = true;
			unlockedV2 = true;
		}
	};
	/**
	 * Tally an unlocked wallet onto the list whose scheduler modules need kicking.
	 *
	 * `Funding` is deliberately tallied to NEITHER list: fund wallets drive no
	 * selling/purchasing module, so kicking those would be pure waste. This is an
	 * explicit no-op rather than a silent `else if` fall-through so that adding a
	 * fourth HotWalletType forces a decision here — the queries feeding these
	 * sweeps filter on lock state, not type, so every wallet type reaches this
	 * code and the compiler gives no signal (there is no exhaustiveness check on
	 * HotWalletType anywhere in the repo).
	 */
	const tallyUnlockedWallet = (wallet: { id: string; type: HotWalletType }) => {
		if (wallet.type === HotWalletType.Selling) {
			unlockedSellingWalletIds.push(wallet.id);
		} else if (wallet.type === HotWalletType.Purchasing) {
			unlockedPurchasingWalletIds.push(wallet.id);
		}
	};
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
							include: {
								SmartContractWallet: {
									where: { deletedAt: null },
									include: { PaymentSource: { select: { paymentSourceType: true } } },
								},
							},
						});
						for (const paymentRequest of result) {
							if (paymentRequest.currentTransactionId == null) {
								if (
									paymentRequest.SmartContractWallet != null &&
									paymentRequest.SmartContractWallet.pendingTransactionId == null &&
									paymentRequest.SmartContractWallet.lockedAt &&
									new Date(paymentRequest.SmartContractWallet.lockedAt) <
										new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
								) {
									unlockedSellingWalletIds.push(paymentRequest.SmartContractWallet.id);
									markUnlockedByType(paymentRequest.SmartContractWallet.PaymentSource?.paymentSourceType);
								}

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
									paymentRequest.SmartContractWallet != null &&
									((paymentRequest.SmartContractWallet.pendingTransactionId != null &&
										paymentRequest.SmartContractWallet.pendingTransactionId == paymentRequest.currentTransactionId) ||
										(paymentRequest.SmartContractWallet.lockedAt &&
											new Date(paymentRequest.SmartContractWallet.lockedAt) <
												new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL)))
								) {
									unlockedSellingWalletIds.push(paymentRequest.SmartContractWallet.id);
									markUnlockedByType(paymentRequest.SmartContractWallet.PaymentSource?.paymentSourceType);
								}

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
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
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
											// Must match the payment-side filter: only time out requests whose
											// CurrentTransaction is still Pending. Without this guard a shared
											// V2 batch Transaction already advanced to Confirmed by a sibling
											// entry gets matched here and overwritten to FailedViaTimeout,
											// corrupting the sibling's audit record and resetting a request
											// whose funds are confirmed-locked on-chain.
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
							include: {
								SmartContractWallet: {
									where: { deletedAt: null },
									include: { PaymentSource: { select: { paymentSourceType: true } } },
								},
								NextAction: true,
							},
						});
						for (const purchaseRequest of result) {
							if (purchaseRequest.currentTransactionId == null) {
								if (
									purchaseRequest.SmartContractWallet != null &&
									purchaseRequest.SmartContractWallet.pendingTransactionId == null &&
									purchaseRequest.SmartContractWallet.lockedAt &&
									new Date(purchaseRequest.SmartContractWallet.lockedAt) <
										new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
								) {
									unlockedPurchasingWalletIds.push(purchaseRequest.SmartContractWallet.id);
									markUnlockedByType(purchaseRequest.SmartContractWallet.PaymentSource?.paymentSourceType);
								}

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
									purchaseRequest.SmartContractWallet != null &&
									((purchaseRequest.SmartContractWallet.pendingTransactionId != null &&
										purchaseRequest.SmartContractWallet.pendingTransactionId == purchaseRequest.currentTransactionId) ||
										(purchaseRequest.SmartContractWallet.lockedAt &&
											new Date(purchaseRequest.SmartContractWallet.lockedAt) <
												new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL)))
								) {
									unlockedPurchasingWalletIds.push(purchaseRequest.SmartContractWallet.id);
									markUnlockedByType(purchaseRequest.SmartContractWallet.PaymentSource?.paymentSourceType);
								}

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
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
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
									in: [
										RegistrationState.RegistrationInitiated,
										RegistrationState.DeregistrationInitiated,
										RegistrationState.UpdateInitiated,
									],
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
							include: {
								SmartContractWallet: {
									include: { PaymentSource: { select: { paymentSourceType: true } } },
								},
								CurrentTransaction: { select: { txHash: true, createdAt: true } },
							},
						});

						for (const registryRequest of result) {
							if (registryRequest.currentTransactionId == null) {
								if (
									registryRequest.SmartContractWallet != null &&
									registryRequest.SmartContractWallet.pendingTransactionId == null &&
									registryRequest.SmartContractWallet.lockedAt &&
									new Date(registryRequest.SmartContractWallet.lockedAt) <
										new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL)
								) {
									if (registryRequest.SmartContractWallet.type === HotWalletType.Selling) {
										unlockedSellingWalletIds.push(registryRequest.SmartContractWallet.id);
									} else if (registryRequest.SmartContractWallet.type === HotWalletType.Purchasing) {
										unlockedPurchasingWalletIds.push(registryRequest.SmartContractWallet.id);
									} else {
										logger.debug('Registry wallet has unexpected HotWalletType; unlocking on both lists as fallback', {
											walletId: registryRequest.SmartContractWallet.id,
											type: registryRequest.SmartContractWallet.type,
										});
										unlockedSellingWalletIds.push(registryRequest.SmartContractWallet.id);
										unlockedPurchasingWalletIds.push(registryRequest.SmartContractWallet.id);
									}
									markUnlockedByType(registryRequest.SmartContractWallet.PaymentSource?.paymentSourceType);
								}

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
												: registryRequest.state == RegistrationState.UpdateInitiated
													? RegistrationState.UpdateFailed
													: RegistrationState.DeregistrationFailed,
										error: 'Timeout, force unlocked',
									},
								});
							} else {
								// #10: a registry tx with txHash set was already accepted by the node
								// (registry services write txHash atomically with state=*Initiated only
								// AFTER submitTx returns). Registry txs carry NO invalidHereafter TTL, so
								// it can still land at any future slot — the usual reason it is still
								// unconfirmed past the timeout is Blockfrost indexer lag, not a dead tx.
								// Force-failing it here and letting the operator re-create would
								// double-mint / double-burn when the original lands. Leave it for registry
								// tx-sync, which polls *Initiated + txHash until the asset appears, then
								// confirms + unlocks. Only the never-broadcast case (txHash == null,
								// handled below) is safe to force-fail + unlock + resubmit — its inputs
								// were never spent.
								if (registryRequest.CurrentTransaction?.txHash != null) {
									const ageMs = registryRequest.CurrentTransaction.createdAt
										? Date.now() - new Date(registryRequest.CurrentTransaction.createdAt).getTime()
										: null;
									logger.warn(
										'Registry request tx is submitted (txHash set) but still unconfirmed past the timeout window; NOT force-failing to avoid a double mint/burn (registry txs have no TTL and may still land). Leaving for registry tx-sync.',
										{
											registryRequestId: registryRequest.id,
											txHash: registryRequest.CurrentTransaction.txHash,
											state: registryRequest.state,
											ageMs,
										},
									);
									continue;
								}
								if (
									registryRequest.SmartContractWallet != null &&
									((registryRequest.SmartContractWallet.pendingTransactionId != null &&
										registryRequest.SmartContractWallet.pendingTransactionId == registryRequest.currentTransactionId) ||
										(registryRequest.SmartContractWallet.lockedAt &&
											new Date(registryRequest.SmartContractWallet.lockedAt) <
												new Date(Date.now() - DEFAULTS.TX_TIMEOUT_INTERVAL)))
								) {
									if (registryRequest.SmartContractWallet.type === HotWalletType.Selling) {
										unlockedSellingWalletIds.push(registryRequest.SmartContractWallet.id);
									} else if (registryRequest.SmartContractWallet.type === HotWalletType.Purchasing) {
										unlockedPurchasingWalletIds.push(registryRequest.SmartContractWallet.id);
									} else {
										logger.debug('Registry wallet has unexpected HotWalletType; unlocking on both lists as fallback', {
											walletId: registryRequest.SmartContractWallet.id,
											type: registryRequest.SmartContractWallet.type,
										});
										unlockedSellingWalletIds.push(registryRequest.SmartContractWallet.id);
										unlockedPurchasingWalletIds.push(registryRequest.SmartContractWallet.id);
									}
									markUnlockedByType(registryRequest.SmartContractWallet.PaymentSource?.paymentSourceType);
								}

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
												: registryRequest.state == RegistrationState.UpdateInitiated
													? RegistrationState.UpdateFailed
													: RegistrationState.DeregistrationFailed,
									},
								});
							}
						}
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
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
							// Prisma `lte` does NOT match NULL — without the explicit null branch
							// below, a PendingTransaction whose lastCheckedAt is NULL (any historical
							// row predating `createPendingTransaction`'s mandatory seed, plus any
							// direct prisma.pendingTransaction.create() bypass) would be invisible
							// here AND to the orphan-lock branch below (which requires
							// pendingTransactionId == null), leaving the wallet stranded.
							// The sibling swap-tx branch in this same file (~L730) uses the same pattern.
							OR: [
								{
									lastCheckedAt: {
										lte: new Date(Date.now() - 1000 * 60 * 1),
									},
								},
								{ lastCheckedAt: null },
							],
						},
						// lockedAt sub-OR:
						//  - `lockedAt < timeout`: standard stale-lock orphan.
						//  - `lockedAt: null`: corrupt half-state — wallet still
						//    references a PendingTransaction but the lock was
						//    cleared (e.g., by a partial revert mid-flow). We
						//    sweep this so the dangling FK is cleaned up. The
						//    `lastCheckedAt` outer filter above already excludes
						//    fresh transactions, so this only matches when the
						//    referenced Tx is genuinely stale.
						//    Narrow false-positive: a transaction with
						//    `lastCheckedAt: null` (legacy seed bypass) on a
						//    wallet whose lock was just cleared would be swept
						//    even though the Tx may still be in flight. Accepted
						//    risk — the alternative (skipping the null branch)
						//    leaves corrupt half-states stranded indefinitely,
						//    which is worse for operators.
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
		// PaymentSource is non-nullable on HotWallet — the relation is required,
		// so `wallet.PaymentSource.paymentSourceType` is always present and we
		// can pass it through markUnlockedByType without an optional chain below.

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
						tallyUnlockedWallet(wallet);
						markUnlockedByType(wallet.PaymentSource.paymentSourceType);
						return;
					}
					const txHash = wallet.PendingTransaction.txHash;
					if (txHash == null) {
						// Ambiguous-funding safety net. If the row was written by the V2
						// collateral-prep / batch-payments path it carries an
						// `intendedTxHash` (and `invalidHereafterSlot`) — meaning a tx
						// body WAS signed and possibly broadcast, but the submitTx
						// outcome was ambiguous. Blindly disconnecting here would
						// strand a potentially on-chain tx and double-spend the inputs
						// on the next batch.
						//
						// Delegate to the funding-reconciliation worker's per-row
						// logic. It queries Blockfrost using `intendedTxHash`,
						// promotes intended → txHash on a hit, and only reverts
						// (disconnect + clear lock + mark RolledBack) once the TTL
						// has provably elapsed. wallet-timeouts thus becomes the
						// unified safety net while the dedicated reconciler cron
						// remains the fast path.
						//
						// The funding-reconciliation revert path itself disconnects
						// the wallet inside its Serializable $transaction, so if
						// reconcileOne resolves the row (either promote or revert)
						// the wallet is freed atomically. If reconcileOne returns
						// without resolving (still within TTL, transient indexer
						// error, etc.) we bump lastCheckedAt and bail — next
						// wallet-timeouts tick re-evaluates.
						const intendedTxHash = wallet.PendingTransaction.intendedTxHash;
						if (intendedTxHash != null) {
							try {
								const candidate: ReconcileCandidate = {
									id: wallet.PendingTransaction.id,
									intendedTxHash,
									invalidHereafterSlot: wallet.PendingTransaction.invalidHereafterSlot,
									BlocksWallet: {
										id: wallet.id,
										PaymentSource: {
											network: wallet.PaymentSource.network,
											PaymentSourceConfig: {
												rpcProviderApiKey: wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
											},
										},
									},
								};
								await reconcileOne(candidate);
								// reconcileOne is idempotent and may have updated/freed the
								// wallet inside its own $transaction. Re-read tally below
								// from a fresh hotWallet query at next tick. Don't
								// double-count unlocks here.
							} catch (err) {
								// Treat as transient — leave Pending, do NOT disconnect.
								// Next tick (either this cron or the dedicated reconciler)
								// will retry. Bump lastCheckedAt to throttle the retry.
								logger.warn('wallet-timeouts: reconcileOne threw, leaving row Pending', {
									txId: wallet.PendingTransaction.id,
									intendedTxHash,
									error: errorToString(err),
								});
								try {
									await prisma.transaction.update({
										where: { id: wallet.PendingTransaction.id },
										data: { lastCheckedAt: new Date() },
									});
								} catch (bumpError) {
									// Best-effort throttle; if this consistently fails (DB
									// outage, row deleted concurrently) the wallet-timeouts
									// scheduler hot-loops the same row every tick. Log at
									// warn so operators see the cause instead of a silent
									// loop.
									logger.warn('wallet-timeouts: failed to bump lastCheckedAt on intendedTxHash candidate', {
										transactionId: wallet.PendingTransaction.id,
										walletId: wallet.id,
										error: bumpError instanceof Error ? bumpError.message : String(bumpError),
									});
								}
							}
							return;
						}
						// No intendedTxHash → genuine orphan (e.g. legacy V1 path that
						// signed but never recorded an intended hash). Preserve the
						// previous blind-disconnect behavior; nothing on chain we
						// could be stranding.
						//
						// This premise ONLY holds for callers that record intendedTxHash
						// before broadcast — for them `intendedTxHash == null` proves the
						// body was never signed or sent, so disconnecting is safe. A
						// caller that submits BEFORE recording would land here with a tx
						// possibly already on chain, and this branch would free the wallet
						// for a duplicate send. Fund distribution originally had that bug
						// (MAS-392); it now records pre-submit like V1/V2 batch-payments.
						// Any new flow that locks a HotWallet must do the same.
						await prisma.hotWallet.update({
							where: { id: wallet.id, deletedAt: null },
							data: {
								PendingTransaction: { disconnect: true },
								lockedAt: null,
							},
						});
						tallyUnlockedWallet(wallet);
						markUnlockedByType(wallet.PaymentSource.paymentSourceType);
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
							//
							// Pass the wallet id so the disconnect + lockedAt clear runs INSIDE
							// the propagation $transaction. Atomic with dependent advance —
							// previously these were two separate writes and a crash between
							// them stranded the wallet locked forever.
							await retryOnSerializationConflict(
								() =>
									markTransactionPhase2Failed(wallet.PendingTransaction!.id, txHash, {
										walletIdsToUnlock: [wallet.id],
									}),
								{ label: 'wallet-timeouts-phase-2-propagate' },
							);
						} else {
							// Tx landed and validContract=true (or null couldn't determine):
							// just unlock the wallet — no dependents to advance. Kept outside
							// the propagation transaction because no propagation runs here.
							await prisma.hotWallet.update({
								where: { id: wallet.id, deletedAt: null },
								data: {
									PendingTransaction: { disconnect: true },
									lockedAt: null,
								},
							});
						}
						tallyUnlockedWallet(wallet);
						markUnlockedByType(wallet.PaymentSource.paymentSourceType);
					} else {
						// A no-TTL tx (registry burn+mint / single-item register+deregister —
						// createPendingTransaction leaves invalidHereafterSlot null) that was
						// dropped from the mempool never becomes provably expired: fetchTxInfo
						// stays null forever and the wallet keeps its PendingTransaction +
						// lockedAt indefinitely, wedging every request that needs it (e.g. a
						// queued registry UpdateRequested, which lockAndQueryRegistryRequests
						// only picks up when the holder wallet is lockedAt:null AND
						// PendingTransaction:null). Force-unlock once such an unseen no-TTL tx
						// is older than the wallet-lock timeout, mirroring the other time-based
						// sweeps here. TTL-bearing txs keep polling — failing one before its
						// validity window provably elapses could double-spend if it still lands.
						const pendingTx = wallet.PendingTransaction;
						// Positively confirm this is a REGISTRY tx (agent register/deregister/
						// update mint-burn) before force-unlocking. Registry txs carry no
						// on-chain TTL, so a dropped one is safe to give up on. A payment/
						// purchase tx, by contrast, DOES carry an on-chain invalidHereafter TTL
						// even though createPendingTransaction leaves the DB slot null — force-
						// failing one inside its validity window could double-spend a locked
						// script UTxO, so those are left to the request-level timeout sweeps.
						const registryRefCount =
							(await prisma.registryRequest.count({ where: { currentTransactionId: pendingTx.id } })) +
							(await prisma.inboxAgentRegistrationRequest.count({ where: { currentTransactionId: pendingTx.id } }));
						const decision = classifyUnseenPendingTx({
							createdAtMs: pendingTx.createdAt.getTime(),
							nowMs: Date.now(),
							invalidHereafterSlot: pendingTx.invalidHereafterSlot,
							isRegistryTx: registryRefCount > 0,
							forceUnlockAfterMs: CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL,
						});
						if (decision.forceUnlock) {
							logger.warn(
								`wallet-timeouts: force-unlocking wallet ${wallet.id} — broadcast no-TTL tx ${pendingTx.txHash} unseen on chain for ${decision.ageMs}ms (likely dropped from the mempool); marking FailedViaTimeout and releasing the lock so dependent requests can proceed`,
								{ walletId: wallet.id, txId: pendingTx.id, txHash: pendingTx.txHash, ageMs: decision.ageMs },
							);
							// Atomic: release the wallet and mark the tx failed together, so a
							// crash between the two writes can't leave the wallet pointing at a
							// FailedViaTimeout tx. Deliberately do NOT re-arm the dependent
							// registry request: registry tx-sync still confirms it by asset
							// presence if the tx actually landed, and re-arming would risk a
							// double mint/burn (or stranding an update on its bumped identifier).
							const didForceUnlock = await retryOnSerializationConflict(
								() =>
									prisma.$transaction(
										async (dbTx) => {
											// Optimistic guard (read-then-act TOCTOU): only free the wallet if
											// it STILL points at this pending tx. Between the fetchTxInfo(null)
											// read above and here, registry tx-sync may have confirmed this tx
											// and a new request re-locked the wallet; without the
											// pendingTransactionId guard we would blind-disconnect that fresh
											// lock and free a wallet with an in-flight tx. updateMany (not
											// update) so a non-match is a no-op instead of throwing. Every
											// other sweep in this file uses the same guard.
											const freed = await dbTx.hotWallet.updateMany({
												where: { id: wallet.id, deletedAt: null, pendingTransactionId: pendingTx.id },
												data: { pendingTransactionId: null, lockedAt: null },
											});
											if (freed.count === 0) {
												return false;
											}
											// Only fail the tx if it is still Pending — a concurrent
											// confirmation must win.
											await dbTx.transaction.updateMany({
												where: { id: pendingTx.id, status: TransactionStatus.Pending },
												data: { status: TransactionStatus.FailedViaTimeout, lastCheckedAt: new Date() },
											});
											return true;
										},
										{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
									),
								{ label: 'wallet-timeouts-force-unlock-registry' },
							);
							if (didForceUnlock) {
								tallyUnlockedWallet(wallet);
								markUnlockedByType(wallet.PaymentSource.paymentSourceType);
							}
						} else {
							await prisma.transaction.update({
								where: { id: pendingTx.id },
								data: { lastCheckedAt: new Date() },
							});
						}
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

					tallyUnlockedWallet(wallet);
					markUnlockedByType(wallet.PaymentSource.paymentSourceType);
				} catch (error) {
					logger.error(`Error updating timed out wallet: ${errorToString(error)}`);
				}
			}),
		);
		const uniqueUnlockedSellingWalletIds = [...new Set(unlockedSellingWalletIds)].filter((id) => id != null);
		const uniqueUnlockedPurchasingWalletIds = [...new Set(unlockedPurchasingWalletIds)].filter((id) => id != null);
		// Only kick scheduler modules whose payment source actually had wallets
		// unlocked above. Iterating both V1 and V2 unconditionally re-scans every
		// payment source on every tick even when nothing on that side changed.
		// markUnlockedByType defaults to setting both flags when type is unknown,
		// so this never under-runs.
		const sellingModules: Array<typeof web3CardanoV1 | typeof web3CardanoV2> = [];
		if (unlockedV1) sellingModules.push(web3CardanoV1);
		if (unlockedV2) sellingModules.push(web3CardanoV2);
		const purchasingModules: Array<typeof web3CardanoV1 | typeof web3CardanoV2> = [];
		if (unlockedV1) purchasingModules.push(web3CardanoV1);
		if (unlockedV2) purchasingModules.push(web3CardanoV2);
		//TODO: reset initialized actions
		if (uniqueUnlockedSellingWalletIds.length > 0) {
			for (const module of sellingModules) {
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
			for (const module of purchasingModules) {
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
			if (unlockedV1) {
				try {
					await web3CardanoV1.cancelRefunds();
				} catch (error) {
					logger.error(`Error initiating cancel refund: ${errorToString(error)}`);
				}
			}
			if (unlockedV2) {
				try {
					await web3CardanoV2.authorizeWithdrawals();
				} catch (error) {
					logger.error(`Error initiating authorize withdrawal: ${errorToString(error)}`);
				}
			}
		}
		try {
			const errorHotWallets = await prisma.hotWallet.findMany({
				where: {
					PendingTransaction: { isNot: null },
					lockedAt: null,
					deletedAt: null,
				},
				include: {
					PendingTransaction: true,
					PaymentSource: {
						include: { PaymentSourceConfig: true },
					},
				},
			});
			for (const hotWallet of errorHotWallets) {
				const pendingTransaction = hotWallet.PendingTransaction;
				// Ambiguous-funding guard — mirrors the `txHash == null && intendedTxHash != null`
				// branch in the lockedHotWallets loop above. A V2 collateral-prep / batch-payments
				// tx records `intendedTxHash` BEFORE broadcast; on an ambiguous submit the row stays
				// Pending with `txHash == null` while the wallet can land in exactly the
				// `{ pendingTransactionId set, lockedAt null }` half-state this sweep matches. Blindly
				// disconnecting it would strand a possibly on-chain tx and let the next batch tick
				// re-lock the same UTxOs → double-spend. Delegate to reconcileOne instead (it is
				// explicitly designed to be driven from this sweep — see funding-reconciliation
				// docs): it only disconnects once the TTL has provably elapsed and the chain confirms
				// the tx never landed, otherwise it leaves the row Pending for the next tick.
				if (
					pendingTransaction != null &&
					pendingTransaction.txHash == null &&
					pendingTransaction.intendedTxHash != null
				) {
					logger.warn(
						`Hot wallet ${hotWallet.id} in invalid locked state references an ambiguous funding tx (intendedTxHash set); delegating to reconcileOne instead of disconnecting`,
						{ txId: pendingTransaction.id, intendedTxHash: pendingTransaction.intendedTxHash },
					);
					try {
						const candidate: ReconcileCandidate = {
							id: pendingTransaction.id,
							intendedTxHash: pendingTransaction.intendedTxHash,
							invalidHereafterSlot: pendingTransaction.invalidHereafterSlot,
							BlocksWallet: {
								id: hotWallet.id,
								PaymentSource: {
									network: hotWallet.PaymentSource.network,
									PaymentSourceConfig: {
										rpcProviderApiKey: hotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey,
									},
								},
							},
						};
						await reconcileOne(candidate);
					} catch (err) {
						// Transient (indexer flake, etc.) — leave the row Pending, do NOT
						// disconnect. The dedicated reconciliation cron and the next
						// wallet-timeouts tick will retry.
						logger.warn(
							'wallet-timeouts: reconcileOne threw for invalid-locked-state ambiguous tx, leaving row Pending',
							{
								txId: pendingTransaction.id,
								intendedTxHash: pendingTransaction.intendedTxHash,
								error: errorToString(err),
							},
						);
					}
					continue;
				}
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
		release?.();
	}
}
