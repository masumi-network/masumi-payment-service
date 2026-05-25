import {
	HotWallet,
	HotWalletType,
	PaymentSourceType,
	PurchaseErrorType,
	PurchasingAction,
	Prisma,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { SLOT_CONFIG_NETWORK, UTxO, unixTimeToEnclosingSlot } from '@meshsdk/core';
import type { BlockfrostProvider, MeshWallet } from '@/services/shared';
import { Transaction } from '@/services/shared';
import { logger } from '@masumi/payment-core/logger';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { SmartContractState } from '@/utils/generator/contract-generator';
import { convertNetwork } from '@/utils/converter/network-convert';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { CONSTANTS } from '@masumi/payment-core/config';
import { calculateMinUtxo, DUMMY_RESULT_HASH } from '@/utils/min-utxo';
import { toBalanceMapFromMeshUtxos, walletLowBalanceMonitorService } from '@/services/wallets';
import {
	connectExistingTransaction,
	connectPreviousAction,
	createMeshProvider,
	createNextPurchaseAction,
} from '@/services/shared';
import { createDatumFromBlockchainIdentifierV2 } from '@masumi/payment-source-v2';

type PaymentSourceWithWallets = Prisma.PaymentSourceGetPayload<{
	include: {
		PurchaseRequests: {
			include: {
				PaidFunds: true;
				SellerWallet: true;
				SmartContractWallet: true;
				NextAction: true;
				CurrentTransaction: true;
				HotWalletLimit: { select: { id: true } };
			};
		};
		PaymentSourceConfig: true;
		HotWallets: {
			include: {
				Secret: true;
			};
		};
	};
}>;

type PurchaseRequestWithRelations = PaymentSourceWithWallets['PurchaseRequests'][number];

type BatchedRequest = {
	paymentRequest: PurchaseRequestWithRelations;
	overpaidLovelace: bigint;
};

type WalletPairing = {
	wallet: MeshWallet;
	scriptAddress: string;
	walletId: string;
	changeAddress: string;
	collectionAddress: string | null;
	utxos: UTxO[];
	batchedRequests: BatchedRequest[];
	// Placeholder Transaction row id created at lock time. The placeholder
	// already carries `BlocksWallet → wallet` so the wallet's
	// pendingTransactionId points at it; executeSpecificBatchPayment updates
	// this row (rather than creating a new sharedTx) since
	// HotWallet.pendingTransactionId @unique permits one connected Tx at a
	// time. Null when the upstream lock-and-query path used a wallet that
	// pre-existed the placeholder convention (defensive fallback for the
	// transitional upgrade window — should not occur in steady state).
	placeholderTransactionId: string | null;
};

async function unlockUnusedPurchasingWallets(candidateWalletIds: string[], usedWalletIds: string[]) {
	const usedWalletIdSet = new Set(usedWalletIds);
	const unusedWalletIds = candidateWalletIds.filter((walletId) => !usedWalletIdSet.has(walletId));
	if (unusedWalletIds.length === 0) {
		return;
	}

	// Each unused wallet still carries the placeholder Transaction created at
	// lock time (BlocksWallet → wallet). Mark the placeholder RolledBack and
	// disconnect it before clearing lockedAt. Without the rollback the
	// placeholder would sit Pending forever and tx-sync / wallet-timeouts
	// would re-discover it every tick; without the disconnect the wallet
	// stays orphan-locked (HotWallet.pendingTransactionId points at a row
	// with no txHash, no progressing batch). Per-wallet write because
	// pendingTransactionId is @unique — can't bulk-disconnect via updateMany.
	await Promise.all(
		unusedWalletIds.map(async (walletId) => {
			const wallet = await prisma.hotWallet.findUnique({
				where: { id: walletId, deletedAt: null },
				select: { pendingTransactionId: true },
			});
			if (wallet?.pendingTransactionId != null) {
				try {
					await prisma.transaction.update({
						where: { id: wallet.pendingTransactionId },
						data: { status: TransactionStatus.RolledBack },
					});
				} catch (rollbackError) {
					logger.warn('batch-payments unused-wallet placeholder rollback failed (non-fatal)', {
						walletId,
						placeholderId: wallet.pendingTransactionId,
						error: rollbackError instanceof Error ? rollbackError.message : rollbackError,
					});
				}
			}
			await prisma.hotWallet.update({
				where: { id: walletId, deletedAt: null },
				data: {
					lockedAt: null,
					PendingTransaction: { disconnect: true },
				},
			});
		}),
	);
}

const mutex = new Mutex();

async function executeSpecificBatchPayment(
	walletPairing: WalletPairing,
	paymentContract: PaymentSourceWithWallets,
	blockchainProvider: BlockfrostProvider,
): Promise<boolean> {
	const wallet = walletPairing.wallet;
	const walletId = walletPairing.walletId;
	const batchedRequests = walletPairing.batchedRequests;

	//batch payments
	const unsignedTx = new Transaction({
		initiator: wallet,
		fetcher: blockchainProvider,
	}).setMetadata(674, {
		msg: ['Masumi', 'PaymentBatched'],
	});
	logger.info('Batching payments, adding metadata');
	for (const data of batchedRequests) {
		const buyerAddress = wallet.getUsedAddress().toBech32() as string;
		const sellerAddress = data.paymentRequest.SellerWallet.walletAddress;
		const submitResultTime = data.paymentRequest.submitResultTime;
		const unlockTime = data.paymentRequest.unlockTime;
		const externalDisputeUnlockTime = data.paymentRequest.externalDisputeUnlockTime;
		const buyerReturnAddress = data.paymentRequest.buyerReturnAddress ?? walletPairing.collectionAddress;

		if (data.paymentRequest.payByTime == null) {
			throw new Error('Pay by time is null, this is deprecated');
		}

		const datum = createDatumFromBlockchainIdentifierV2({
			buyerAddress: buyerAddress,
			buyerReturnAddress,
			sellerAddress: sellerAddress,
			sellerReturnAddress: data.paymentRequest.sellerReturnAddress,
			blockchainIdentifier: data.paymentRequest.blockchainIdentifier,
			inputHash: data.paymentRequest.inputHash,
			payByTime: data.paymentRequest.payByTime,
			collateralReturnLovelace: data.overpaidLovelace,
			resultHash: null,
			resultTime: submitResultTime,
			unlockTime: unlockTime,
			externalDisputeUnlockTime: externalDisputeUnlockTime,
			newCooldownTimeSeller: BigInt(0),
			newCooldownTimeBuyer: BigInt(0),
			state: SmartContractState.FundsLocked,
		});
		logger.info('Batching payments, adding datum for payment request', {
			paymentRequestId: data.paymentRequest.id,
		});

		unsignedTx.sendAssets(
			{
				address: walletPairing.scriptAddress,
				datum,
			},
			data.paymentRequest.PaidFunds.map((amount) => ({
				unit: amount.unit == '' ? 'lovelace' : amount.unit,
				quantity: amount.amount.toString(),
			})),
		);
	}

	// Shared-Transaction pre-submit: REUSE the placeholder Transaction created
	// at wallet-lock time (already carries BlocksWallet → wallet). Every
	// batched purchase request connects to it via CurrentTransaction. Avoids
	// the N-orphan pattern that breaks HotWallet.pendingTransactionId @unique
	// (only the last create would survive).
	//
	// Falls back to creating a fresh sharedTx if the placeholder is missing —
	// defensive guard for the transitional upgrade window (e.g. an in-flight
	// scheduler tick from before this version landed). Should not occur in
	// steady state.
	const sharedTxId = await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					let resolvedSharedTxId: string;
					if (walletPairing.placeholderTransactionId != null) {
						// Reuse path: bump `lastCheckedAt` so wallet-timeouts'
						// 1-min debounce resets against the new ts (the placeholder
						// is now actively progressing through pre-submit / submit /
						// post-submit) and reaffirm the BlocksWallet connection
						// defensively in case a competing writer touched it.
						await tx.transaction.update({
							where: { id: walletPairing.placeholderTransactionId },
							data: {
								status: TransactionStatus.Pending,
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: walletId } },
							},
						});
						resolvedSharedTxId = walletPairing.placeholderTransactionId;
					} else {
						const sharedTx = await tx.transaction.create({
							data: {
								status: TransactionStatus.Pending,
								// `lastCheckedAt: now` required so wallet-timeouts can poll this row.
								// See docs/adr/0006 and docs/adr/0007 for the full rationale.
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: walletId } },
							},
						});
						resolvedSharedTxId = sharedTx.id;
					}
					for (const request of batchedRequests) {
						logger.info('Batching payments, updating purchase request', {
							paymentRequestId: request.paymentRequest.id,
						});
						await tx.purchaseRequest.update({
							where: { id: request.paymentRequest.id },
							data: {
								...connectPreviousAction(request.paymentRequest.nextActionId),
								...createNextPurchaseAction(PurchasingAction.FundsLockingInitiated),
								collateralReturnLovelace: request.overpaidLovelace,
								SmartContractWallet: { connect: { id: walletId } },
								buyerReturnAddress: request.paymentRequest.buyerReturnAddress ?? walletPairing.collectionAddress,
								...connectExistingTransaction(resolvedSharedTxId),
								TransactionHistory: request.paymentRequest.CurrentTransaction
									? { connect: { id: request.paymentRequest.CurrentTransaction.id } }
									: undefined,
							},
						});
					}
					return resolvedSharedTxId;
				},
				{ timeout: 30_000 },
			),
		{ label: 'batch-payments-v2-presubmit' },
	);

	logger.info('Batching payments, purchase request initialized');

	const invalidBefore =
		unixTimeToEnclosingSlot(Date.now() - 150000, SLOT_CONFIG_NETWORK[convertNetwork(paymentContract.network)]) - 1;

	const invalidAfter =
		unixTimeToEnclosingSlot(Date.now() + 150000, SLOT_CONFIG_NETWORK[convertNetwork(paymentContract.network)]) + 5;
	unsignedTx.setNetwork(convertNetwork(paymentContract.network));
	unsignedTx.txBuilder.invalidBefore(invalidBefore);
	unsignedTx.txBuilder.invalidHereafter(invalidAfter);

	const completeTx = await unsignedTx.build();
	logger.info('Batching payments, complete tx built');
	const signedTx = await wallet.signTx(completeTx);
	logger.info('Batching payments, tx signed');

	let txHash: string;
	try {
		txHash = await wallet.submitTx(signedTx);
	} catch (submitError) {
		// `submitTx` threw — the on-chain submission either never reached the
		// node or returned an error before broadcast. The outer
		// `Promise.allSettled` catch will advance every batched request to
		// `WaitingForManualAction` (intentional: re-batching would risk
		// double-payment on a timeout-but-tx-actually-landed edge case), but
		// it does NOT touch the shared Transaction row this function created
		// pre-submit. Without the mark below, the row would sit `Pending`
		// forever with no `txHash`, no `BlocksWallet` (the outer catch
		// disconnects it via `hotWallet.update`), and no `CurrentTransaction`
		// back-edges that survive the per-request `WaitingForManualAction`
		// advance — invisible to both wallet-timeouts and tx-sync, accumulating
		// as DB pollution every time a buyer-side submit fails. Best-effort
		// retry on serialization conflict, then rethrow so the outer catch
		// runs the per-request state advance.
		try {
			await retryOnSerializationConflict(
				() =>
					prisma.transaction.update({
						where: { id: sharedTxId },
						data: { status: TransactionStatus.RolledBack },
					}),
				{ label: 'batch-payments-v2-rollback-mark' },
			);
		} catch (rollbackError) {
			logger.warn('batch-payments shared Tx rollback mark failed (non-fatal)', {
				sharedTxId,
				submitError: submitError instanceof Error ? submitError.message : submitError,
				rollbackError: rollbackError instanceof Error ? rollbackError.message : rollbackError,
			});
		}
		throw submitError;
	}

	await walletLowBalanceMonitorService.evaluateProjectedHotWalletById({
		hotWalletId: walletId,
		walletAddress: walletPairing.changeAddress,
		walletUtxos: walletPairing.utxos,
		unsignedTx: completeTx,
		checkSource: 'submission',
	});

	logger.info('Batching payments, tx submitted', {
		txHash: txHash,
	});

	// Post-submit: single shared Transaction row receives the txHash. No
	// per-request loop required.
	await prisma.transaction.update({
		where: { id: sharedTxId },
		data: { txHash },
	});
	logger.info('Batching payments, purchase request updated');

	return true;
}

export async function batchLatestPaymentEntriesV2() {
	const maxBatchSize = 10;

	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentContractsWithWalletLocked = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (prisma) => {
						const payByTime = new Date().getTime() + 1000 * 57;
						const paymentContracts = await prisma.paymentSource.findMany({
							where: {
								deletedAt: null,
								paymentSourceType: PaymentSourceType.Web3CardanoV2,
								HotWallets: {
									some: {
										PendingTransaction: null,
										type: HotWalletType.Purchasing,
										deletedAt: null,
									},
								},
							},
							include: {
								PurchaseRequests: {
									where: {
										NextAction: {
											requestedAction: PurchasingAction.FundsLockingRequested,
											errorType: null,
										},
										CurrentTransaction: { is: null },
										onChainState: null,
										payByTime: { gte: payByTime },
									},
									include: {
										PaidFunds: true,
										SellerWallet: true,
										SmartContractWallet: { where: { deletedAt: null } },
										NextAction: true,
										CurrentTransaction: true,
										HotWalletLimit: { select: { id: true } },
									},
									orderBy: {
										createdAt: 'asc',
									},
									take: maxBatchSize,
								},
								PaymentSourceConfig: true,
								HotWallets: {
									where: {
										PendingTransaction: null,
										lockedAt: null,
										type: HotWalletType.Purchasing,
										deletedAt: null,
									},
									include: {
										Secret: true,
									},
								},
							},
						});

						const walletsToLock: HotWallet[] = [];
						const paymentContractsToUse = [];
						for (const paymentContract of paymentContracts) {
							const purchaseRequests = [];
							for (const purchaseRequest of paymentContract.PurchaseRequests) {
								//if the purchase request times out in less than 5 minutes, we ignore it
								const maxSubmitResultTime = Date.now() - 1000 * 60 * 5;
								if (purchaseRequest.inputHash == null) {
									logger.info('Purchase request has no input hash, ignoring', {
										purchaseRequest: purchaseRequest,
									});
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
													requestedAction: PurchasingAction.WaitingForManualAction,
													errorType: PurchaseErrorType.Unknown,
													errorNote: 'Purchase request has no input hash',
												},
											},
										},
									});
									continue;
								} else if (purchaseRequest.submitResultTime < maxSubmitResultTime) {
									logger.info('Purchase request times out in less than 5 minutes, ignoring', {
										purchaseRequest: purchaseRequest,
									});
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
													requestedAction: PurchasingAction.FundsLockingRequested,
													errorType: PurchaseErrorType.Unknown,
													errorNote: 'Transaction timeout before sending',
												},
											},
										},
									});
									continue;
								}
								purchaseRequests.push(purchaseRequest);
							}
							if (purchaseRequests.length == 0) {
								continue;
							}
							paymentContract.PurchaseRequests = purchaseRequests;
							for (const wallet of paymentContract.HotWallets) {
								if (!walletsToLock.some((w) => w.id === wallet.id)) {
									walletsToLock.push(wallet);
									// Create a placeholder Transaction row BEFORE setting
									// lockedAt and connect it as the wallet's PendingTransaction
									// in the same write. Without the placeholder the wallet
									// orphan-cleanup branch in wallet-timeouts has to wait
									// WALLET_LOCK_TIMEOUT_INTERVAL to detect the orphan via the
									// `lockedAt set + no PendingTransaction` arm (the only path
									// it has for a lock with nothing to poll). With the
									// placeholder, the standard PendingTransaction polling
									// branch picks it up after 1 minute and — because txHash
									// stays null until executeSpecificBatchPayment populates it
									// — disconnects + marks RolledBack via the early-bail
									// `txHash == null` branch in wallet-timeouts/service.ts.
									// `executeSpecificBatchPayment` REUSES this placeholder by
									// updating its `lastCheckedAt` (rather than creating a new
									// sharedTx) since HotWallet.pendingTransactionId @unique
									// allows only one connected Tx at a time.
									const placeholder = await prisma.transaction.create({
										data: {
											status: TransactionStatus.Pending,
											// lastCheckedAt: now keeps wallet-timeouts' 1-min
											// debounce honored — without it the polling cron
											// would fire on the next tick (NULL matches `lte`
											// in Postgres but wallet-timeouts filters on a
											// non-null `lastCheckedAt` via `lte: now-1min`).
											lastCheckedAt: new Date(),
											BlocksWallet: { connect: { id: wallet.id } },
										},
									});
									await prisma.hotWallet.update({
										where: { id: wallet.id, deletedAt: null },
										data: { lockedAt: new Date() },
									});
									// Stash the placeholder Tx id on the wallet object so
									// executeSpecificBatchPayment can reuse it. Wallet is a
									// generated Prisma type, but the closure flows through
									// untyped paymentContract.HotWallets — see
									// loadPlaceholderTxIdForWallet for the read site.
									(wallet as HotWallet & { placeholderTransactionId?: string }).placeholderTransactionId =
										placeholder.id;
								}
							}
							if (paymentContract.PurchaseRequests.length > 0) {
								paymentContractsToUse.push(paymentContract);
							}
						}
						return paymentContractsToUse;
					},
					{ isolationLevel: 'Serializable', maxWait: 10000, timeout: 10000 },
				),
			{ label: 'batch-payments-0' },
		);

		await Promise.allSettled(
			paymentContractsWithWalletLocked.map(async (paymentContract) => {
				try {
					const paymentRequests = paymentContract.PurchaseRequests;
					if (paymentRequests.length == 0) {
						logger.info(
							'No payment requests found for network ' +
								paymentContract.network +
								' ' +
								paymentContract.smartContractAddress,
						);
						return;
					}

					const potentialWallets = paymentContract.HotWallets;
					if (potentialWallets.length == 0) {
						logger.warn('No unlocked wallet to batch payments, skipping');
						return;
					}

					const walletAmounts = await Promise.all(
						potentialWallets.map(async (wallet) => {
							const {
								wallet: meshWallet,
								utxos,
								address,
							} = await generateWalletExtended(
								paymentContract.network,
								paymentContract.PaymentSourceConfig.rpcProviderApiKey,
								wallet.Secret.encryptedMnemonic,
							);
							const balanceMap = toBalanceMapFromMeshUtxos(utxos);
							await walletLowBalanceMonitorService.evaluateHotWalletById(wallet.id, balanceMap, 'submission');
							return {
								wallet: meshWallet,
								walletId: wallet.id,
								changeAddress: address,
								collectionAddress: wallet.collectionAddress,
								utxos,
								scriptAddress: paymentContract.smartContractAddress,
								amounts: Array.from(balanceMap.entries()).map(([unit, quantity]) => ({
									unit: unit === 'lovelace' ? '' : unit,
									quantity,
								})),
								// Surface the placeholder Transaction id stashed on the
								// wallet object inside the outer lock-and-query transaction.
								// Untyped because HotWallet is generated by Prisma —
								// see the placeholder create site above.
								placeholderTransactionId:
									(wallet as HotWallet & { placeholderTransactionId?: string }).placeholderTransactionId ?? null,
							};
						}),
					);
					const paymentRequestsRemaining = [...paymentRequests];
					const walletPairings: WalletPairing[] = [];

					let maxBatchSizeReached = false;

					const blockchainProvider = await createMeshProvider(paymentContract.PaymentSourceConfig.rpcProviderApiKey);

					const protocolParameter = await blockchainProvider.fetchProtocolParameters();

					for (const walletData of walletAmounts) {
						const wallet = walletData.wallet;
						const amounts = walletData.amounts;
						const potentialAddresses = await wallet.getUsedAddresses();
						if (potentialAddresses.length == 0) {
							logger.warn('No addresses found for wallet ' + walletData.walletId);
							continue;
						}
						const batchedPaymentRequests = [];

						let index = 0;
						while (paymentRequestsRemaining.length > 0 && index < paymentRequestsRemaining.length) {
							if (batchedPaymentRequests.length >= maxBatchSize) {
								maxBatchSizeReached = true;
								break;
							}
							const paymentRequest = paymentRequestsRemaining[index];
							if (
								paymentRequest.isLimitedToHotWallets &&
								!paymentRequest.HotWalletLimit.some((hw) => hw.id === walletData.walletId)
							) {
								index++;
								continue;
							}
							// Work on a clone of the Prisma-loaded PaidFunds array. The
							// inner loop augments the lovelace amount with the derived
							// `overestimatedMinUtxoCost` so downstream tx-build code sees
							// the value the on-chain output will actually carry. Mutating
							// `paymentRequest.PaidFunds` directly would persist that
							// augmentation into the Prisma object — harmless on the happy
							// path (we'd reassign anyway) but fragile if any future change
							// reads `paymentRequest.PaidFunds` after a non-fulfilled try,
							// or stores a reference to the row outside this loop. Cloning
							// up front and reassigning on success keeps the original array
							// untouched on the non-fulfilled branch with no explicit
							// rollback step.
							const workingPaidFunds = paymentRequest.PaidFunds.map((f) => ({ ...f }));
							const sellerAddress = paymentRequest.SellerWallet.walletAddress;

							const otherUnits = workingPaidFunds.filter(
								(amount) => amount.unit.toLowerCase() != '' && amount.unit.toLowerCase() != 'lovelace',
							).length;

							// V2 datum carries `collateralReturnLovelace` whose CBOR size
							// grows with the value (a non-zero BigInt is ~3-4 bytes vs 1
							// byte for 0n). The actual on-chain datum will use the
							// derived `overpaidLovelace` as collateralReturnLovelace, so
							// estimating min-UTxO with 0n understates it by ~2 bytes ×
							// coinsPerUtxoSize (~8.6k lovelace at current params). Fix:
							// iterate the min-UTxO calculation until the estimate uses
							// the same collateralReturnLovelace value that the lock
							// output will carry. Two iterations always suffice in
							// practice (the size difference between 0n and ~6M is at
							// most 4 bytes; the second pass's overpaidLovelace is in the
							// same size class as the first, so its CBOR size matches).
							const buildEstimateDatum = (collateralReturnLovelace: bigint) =>
								createDatumFromBlockchainIdentifierV2({
									buyerAddress: walletData.changeAddress,
									buyerReturnAddress: paymentRequest.buyerReturnAddress ?? walletData.collectionAddress,
									sellerAddress: sellerAddress,
									sellerReturnAddress: paymentRequest.sellerReturnAddress,
									blockchainIdentifier: paymentRequest.blockchainIdentifier,
									inputHash: paymentRequest.inputHash,
									payByTime: paymentRequest.payByTime!,
									collateralReturnLovelace,
									resultHash: DUMMY_RESULT_HASH,
									resultTime: BigInt(paymentRequest.submitResultTime),
									unlockTime: BigInt(paymentRequest.unlockTime),
									externalDisputeUnlockTime: BigInt(paymentRequest.externalDisputeUnlockTime),
									newCooldownTimeSeller: BigInt(0),
									newCooldownTimeBuyer: BigInt(0),
									state: SmartContractState.ResultSubmitted,
								});

							const computeMinUtxoFor = (collateralReturnLovelace: bigint) =>
								calculateMinUtxo({
									datum: buildEstimateDatum(collateralReturnLovelace).value,
									nativeTokenCount: otherUnits,
									coinsPerUtxoSize: protocolParameter.coinsPerUtxoSize,
									includeBuffers: true,
								}).minUtxoLovelace;

							const paidLovelaceAtThisPoint =
								workingPaidFunds.find((amount) => amount.unit.toLowerCase() === '')?.amount ?? 0n;

							// Pass 1: estimate min-UTxO assuming no collateral return.
							let overestimatedMinUtxoCost = computeMinUtxoFor(0n);
							// Pass 2: estimate min-UTxO assuming the collateral return
							// value the lock will actually emit (overpaid component of
							// the lovelace going to script). Two iterations is enough —
							// the CBOR length of `overpaidLovelace` is at most 4 bytes
							// for any realistic amount, so the size class is stable.
							const projectedOverpaid =
								overestimatedMinUtxoCost > paidLovelaceAtThisPoint
									? overestimatedMinUtxoCost - paidLovelaceAtThisPoint
									: 0n;
							const iteratedMinUtxoCost = computeMinUtxoFor(projectedOverpaid);
							if (iteratedMinUtxoCost > overestimatedMinUtxoCost) {
								overestimatedMinUtxoCost = iteratedMinUtxoCost;
							}

							//set min ada required;
							const lovelaceRequired = workingPaidFunds.findIndex((amount) => amount.unit.toLowerCase() === '');
							let overpaidLovelace = 0n;
							if (lovelaceRequired == -1) {
								overpaidLovelace = overestimatedMinUtxoCost;
								workingPaidFunds.push({
									unit: '',
									amount: overestimatedMinUtxoCost,
									id: '',
									createdAt: new Date(),
									updatedAt: new Date(),
									paymentRequestId: null,
									purchaseRequestId: null,
									apiKeyId: null,
									agentFixedPricingId: null,
									sellerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPurchaseRequestId: null,
									sellerWithdrawnPurchaseRequestId: null,
								});
							} else if (workingPaidFunds[lovelaceRequired].amount < overestimatedMinUtxoCost) {
								overpaidLovelace = overestimatedMinUtxoCost - workingPaidFunds[lovelaceRequired].amount;
								if (overpaidLovelace < 0n) {
									overpaidLovelace = 0n;
								}
								//we want to be overpaid lovelace to be 0 or at least 1.43523 ada
								//example: overestimatedMinUtxoCost 3 ada
								//paidFunds 2.5 ada
								//overpaidLovelace 0.5 ada
								//we want to be overpaid lovelace to be 1.43523 ada
								//so we need to add 1.43523 ada - 0.5 ada = 0.93523 ada
								if (overpaidLovelace > 0n && overpaidLovelace < CONSTANTS.MIN_COLLATERAL_LOVELACE) {
									overestimatedMinUtxoCost += CONSTANTS.MIN_COLLATERAL_LOVELACE - overpaidLovelace;
									overpaidLovelace = CONSTANTS.MIN_COLLATERAL_LOVELACE;
								}

								workingPaidFunds.splice(lovelaceRequired, 1);
								workingPaidFunds.push({
									unit: '',
									amount: overestimatedMinUtxoCost,
									id: '',
									createdAt: new Date(),
									updatedAt: new Date(),
									paymentRequestId: null,
									purchaseRequestId: null,
									apiKeyId: null,
									agentFixedPricingId: null,
									sellerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPaymentRequestId: null,
									buyerWithdrawnPurchaseRequestId: null,
									sellerWithdrawnPurchaseRequestId: null,
								});
							}
							let isFulfilled = true;
							const needsFeeBuffer = batchedPaymentRequests.length === 0;
							for (const paymentAmount of workingPaidFunds) {
								const walletAmount = amounts.find((amount) => amount.unit == paymentAmount.unit);
								const isLovelace = paymentAmount.unit === '' || paymentAmount.unit.toLowerCase() === 'lovelace';
								const requiredAmount =
									isLovelace && needsFeeBuffer
										? paymentAmount.amount + CONSTANTS.MIN_TX_FEE_BUFFER_LOVELACE
										: paymentAmount.amount;
								if (walletAmount == null || requiredAmount > walletAmount.quantity) {
									isFulfilled = false;
									break;
								}
							}
							if (isFulfilled) {
								const wasFirstRequest = batchedPaymentRequests.length === 0;
								// Adopt the augmented array on the Prisma object so
								// downstream tx-build code (in `executeSpecificBatchPayment`)
								// reads the lovelace value the lock output will carry.
								// Replacing the reference (rather than mutating the original
								// array in-place) keeps the original array object pristine,
								// so any retry / parallel iteration that re-fetches the row
								// from Prisma starts from a clean slate.
								paymentRequest.PaidFunds = workingPaidFunds;
								batchedPaymentRequests.push({
									paymentRequest,
									overpaidLovelace,
								});
								//deduct amounts from wallet
								for (const paymentAmount of workingPaidFunds) {
									const walletAmount = amounts.find((amount) => amount.unit == paymentAmount.unit);
									const isLovelace = paymentAmount.unit === '' || paymentAmount.unit.toLowerCase() === 'lovelace';
									const deductAmount =
										isLovelace && wasFirstRequest
											? paymentAmount.amount + CONSTANTS.MIN_TX_FEE_BUFFER_LOVELACE
											: paymentAmount.amount;
									walletAmount!.quantity -= deductAmount;
								}
								paymentRequestsRemaining.splice(index, 1);
							} else {
								// Nothing to roll back — workingPaidFunds is local; the
								// Prisma object's PaidFunds array was never touched.
								index++;
							}
						}
						if (batchedPaymentRequests.length > 0) {
							logger.info('Batching payments, adding wallet pairing', {
								walletId: walletData.walletId,
								scriptAddress: walletData.scriptAddress,
								batchedRequests: batchedPaymentRequests,
							});
							walletPairings.push({
								wallet: wallet,
								scriptAddress: walletData.scriptAddress,
								walletId: walletData.walletId,
								changeAddress: walletData.changeAddress,
								collectionAddress: walletData.collectionAddress,
								utxos: walletData.utxos,
								batchedRequests: batchedPaymentRequests,
								placeholderTransactionId: walletData.placeholderTransactionId,
							});
						}
					}
					//only go into error state if we did not reach max batch size, as otherwise we might have enough funds in other wallets
					if (paymentRequestsRemaining.length > 0 && maxBatchSizeReached == false) {
						const allWalletCount = await prisma.hotWallet.count({
							where: {
								deletedAt: null,
								type: HotWalletType.Purchasing,
								PendingTransaction: null,
								PaymentSource: {
									id: paymentContract.id,
								},
							},
						});
						//only go into error state if all eligible wallets were unlocked, otherwise we might have enough funds in other wallets
						for (const paymentRequest of paymentRequestsRemaining) {
							const eligibleWalletCount = paymentRequest.isLimitedToHotWallets
								? await prisma.hotWallet.count({
										where: {
											deletedAt: null,
											type: HotWalletType.Purchasing,
											PendingTransaction: null,
											PaymentSource: { id: paymentContract.id },
											id: { in: paymentRequest.HotWalletLimit.map((hw) => hw.id) },
										},
									})
								: allWalletCount;
							const eligiblePotentialCount = paymentRequest.isLimitedToHotWallets
								? potentialWallets.filter((w) => paymentRequest.HotWalletLimit.some((hw) => hw.id === w.id)).length
								: potentialWallets.length;
							if (eligibleWalletCount == eligiblePotentialCount) {
								logger.warn('No wallets with funds found, going into error state for', {
									purchaseRequestId: paymentRequest.id,
								});
								await prisma.purchaseRequest.update({
									where: { id: paymentRequest.id },
									data: {
										ActionHistory: {
											connect: {
												id: paymentRequest.nextActionId,
											},
										},
										NextAction: {
											create: {
												requestedAction: PurchasingAction.WaitingForManualAction,
												errorType: PurchaseErrorType.InsufficientFunds,
												errorNote:
													paymentRequest.inputHash == null
														? 'Purchase request has no input hash and not enough funds in wallets'
														: 'Not enough funds in wallets',
											},
										},
									},
								});
							}
						}
					}

					await unlockUnusedPurchasingWallets(
						potentialWallets.map((wallet) => wallet.id),
						walletPairings.map((walletPairing) => walletPairing.walletId),
					);

					if (walletPairings.length == 0) {
						logger.info('No purchase requests with funds found, skipping');
						return;
					}

					logger.info(`Batching ${walletPairings.length} payments for payment source ${paymentContract.id}`);
					//do not retry, we want to fail if anything goes wrong. There should not be a possibility to pay twice
					await Promise.allSettled(
						walletPairings.map(async (walletPairing) => {
							try {
								return await Promise.race([
									new Promise<boolean>((_, reject) => {
										setTimeout(
											() => {
												reject(new Error('Timeout batching purchase requests'));
											},
											//30 seconds timeout
											30000,
										);
									}),
									executeSpecificBatchPayment(walletPairing, paymentContract, blockchainProvider),
								]);
							} catch (error) {
								logger.error('Error batching payments', {
									error: error,
									walletPairing: walletPairing.batchedRequests,
									walletId: walletPairing.walletId,
								});
								for (const batchedRequest of walletPairing.batchedRequests) {
									await prisma.purchaseRequest.update({
										where: { id: batchedRequest.paymentRequest.id },
										data: {
											ActionHistory: {
												connect: {
													id: batchedRequest.paymentRequest.nextActionId,
												},
											},
											NextAction: {
												create: {
													requestedAction: PurchasingAction.WaitingForManualAction,
													errorType: PurchaseErrorType.Unknown,
													errorNote: 'Batching payments failed: ' + interpretBlockchainError(error),
												},
											},
										},
									});
								}

								// Mark the placeholder Transaction RolledBack BEFORE disconnecting
								// it from the wallet. The inner submitTx failure path already
								// handles this, but pre-submit / post-submit failures land here
								// with the placeholder still Pending — once disconnected and
								// lockedAt cleared, neither wallet-timeouts polling branch nor the
								// orphan-lock branch can find the row again, so without this it
								// would sit Pending forever and accumulate as DB pollution.
								if (walletPairing.placeholderTransactionId != null) {
									try {
										await prisma.transaction.update({
											where: { id: walletPairing.placeholderTransactionId },
											data: { status: TransactionStatus.RolledBack },
										});
									} catch (rollbackError) {
										logger.warn('batch-payments placeholder rollback (outer catch) failed (non-fatal)', {
											walletId: walletPairing.walletId,
											placeholderId: walletPairing.placeholderTransactionId,
											rollbackError: rollbackError instanceof Error ? rollbackError.message : rollbackError,
										});
									}
								}

								await prisma.hotWallet.update({
									where: { id: walletPairing.walletId, deletedAt: null },
									data: {
										lockedAt: null,
										PendingTransaction: { disconnect: true },
									},
								});

								throw error;
							}
						}),
					);
				} catch (error) {
					logger.error('Error batching payments outer', { error: error });

					const potentiallyFailedPurchaseRequests = paymentContract.PurchaseRequests;
					const failedPurchaseRequests = await prisma.purchaseRequest.findMany({
						where: {
							id: { in: potentiallyFailedPurchaseRequests.map((x) => x.id) },
							CurrentTransaction: {
								is: null,
							},
							NextAction: {
								requestedAction: PurchasingAction.FundsLockingRequested,
							},
						},
					});

					// Outer-catch wallet unlock — every wallet that the lock-and-query
					// step touched now carries a placeholder PendingTransaction, so the
					// previous `pendingTransactionId: null` filter would match none of
					// them. Walk each candidate, rollback its placeholder, disconnect,
					// then clear lockedAt — same pattern as unlockUnusedPurchasingWallets
					// uses for the un-selected wallets.
					await Promise.all(
						paymentContract.HotWallets.map(async (candidateWallet) => {
							const fresh = await prisma.hotWallet.findUnique({
								where: { id: candidateWallet.id, deletedAt: null },
								select: { pendingTransactionId: true, type: true },
							});
							if (fresh == null || fresh.type !== HotWalletType.Purchasing) return;
							if (fresh.pendingTransactionId != null) {
								try {
									await prisma.transaction.update({
										where: { id: fresh.pendingTransactionId },
										data: { status: TransactionStatus.RolledBack },
									});
								} catch (rollbackError) {
									logger.warn('batch-payments outer-catch placeholder rollback failed (non-fatal)', {
										walletId: candidateWallet.id,
										placeholderId: fresh.pendingTransactionId,
										rollbackError: rollbackError instanceof Error ? rollbackError.message : rollbackError,
									});
								}
							}
							await prisma.hotWallet.update({
								where: { id: candidateWallet.id, deletedAt: null },
								data: {
									lockedAt: null,
									PendingTransaction: { disconnect: true },
								},
							});
						}),
					);

					await Promise.allSettled(
						failedPurchaseRequests.map(async (x) => {
							await prisma.purchaseRequest.update({
								where: { id: x.id },
								data: {
									ActionHistory: {
										connect: {
											id: x.nextActionId,
										},
									},
									NextAction: {
										create: {
											requestedAction: PurchasingAction.WaitingForManualAction,
											errorType: PurchaseErrorType.Unknown,
											errorNote: 'Outer error: Batching payments failed: ' + interpretBlockchainError(error),
										},
									},
								},
							});
						}),
					);
					throw error;
				}
			}),
		);
	} catch (error) {
		logger.error('Error batching payments', error);
	} finally {
		release();
	}
}
