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
// db/retry + blockchain-error-interpreter now live in @masumi/payment-core.
// wallet-generator and min-utxo intentionally stay in root src/: both import
// @meshsdk/core, so they are V1-mesh-pinned (ADR 0005) and don't belong in core.
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withSerializableSlot } from '@masumi/payment-core/serializable-semaphore';
import { BlockfrostProvider, MeshWallet, Transaction, UTxO, resolveTxHash } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { generateWalletExtended } from '@/utils/generator/wallet-generator';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { convertNetwork } from '@masumi/payment-core/network';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
import { isTransientPreSubmitError } from '@masumi/payment-core/pre-submit-error';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { CONSTANTS } from '@masumi/payment-core/config';
import { calculateMinUtxo, DUMMY_RESULT_HASH } from '@/utils/min-utxo';
import { toBalanceMapFromMeshUtxos, walletLowBalanceMonitorService } from '@/services/wallets';
import {
	connectExistingTransaction,
	connectPreviousAction,
	createMeshProvider,
	createNextPurchaseAction,
	createTxWindow,
} from '@/services/shared';
import { getDatumFromBlockchainIdentifier } from '@masumi/payment-source-v1';

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
};

const mutex = new Mutex();

// Structured outcome of a single batch pairing's submit attempt. Mirrors the V2
// hardening (packages/payment-source-v2/.../batch-payments/service.ts): the
// funding tx and the DB row that records its hash are written in separate steps,
// so a failure between `submitTx` and the hash-record must NOT be collapsed into
// a generic throw. Each variant tells the outer aggregator exactly how safe it is
// to touch request state:
//   - succeeded            → hash recorded; nothing to do.
//   - pre-submit-failed    → never broadcast; safe to revert + unlock.
//   - submit-rejected      → node definitively rejected; safe to revert + unlock.
//   - submit-ambiguous     → tx MAY be on chain; leave Pending + wallet locked,
//                            funding-reconciliation resolves via intendedTxHash.
//   - post-submit-db-failed→ tx IS on chain; retry the hash persist, else fall
//                            through to funding-reconciliation.
type BatchOutcome =
	| { status: 'succeeded'; walletId: string; sharedTxId: string; txHash: string; requestIds: string[] }
	| { status: 'pre-submit-failed'; walletId: string; sharedTxId: string; requestIds: string[]; error: unknown }
	| {
			status: 'submit-rejected';
			walletId: string;
			sharedTxId: string;
			intendedTxHash: string;
			requestIds: string[];
			error: unknown;
	  }
	| {
			status: 'submit-ambiguous';
			walletId: string;
			sharedTxId: string;
			intendedTxHash: string;
			invalidHereafterSlot: number;
			requestIds: string[];
			error: unknown;
	  }
	| {
			status: 'post-submit-db-failed';
			walletId: string;
			sharedTxId: string;
			txHash: string;
			requestIds: string[];
			error: unknown;
	  };

async function executeSpecificBatchPayment(
	walletPairing: WalletPairing,
	paymentContract: PaymentSourceWithWallets,
	blockchainProvider: BlockfrostProvider,
): Promise<BatchOutcome> {
	const wallet = walletPairing.wallet;
	const walletId = walletPairing.walletId;
	const batchedRequests = walletPairing.batchedRequests;
	const requestIds = batchedRequests.map((b) => b.paymentRequest.id);

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

		if (data.paymentRequest.payByTime == null) {
			throw new Error('Pay by time is null, this is deprecated');
		}

		const datum = getDatumFromBlockchainIdentifier({
			buyerAddress: buyerAddress,
			sellerAddress: sellerAddress,
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

	// Single shared Transaction per batch (mirrors V2). The previous pattern
	// called `createPendingTransaction(walletId)` once per request, creating N
	// Transaction rows — but `HotWallet.pendingTransactionId` is @unique, so only
	// the last create kept its BlocksWallet backref and the other N-1 were
	// orphaned. One shared row (carrying BlocksWallet → the signing wallet) gives
	// funding-reconciliation and wallet-timeouts a single deterministic row to
	// resolve, and lets us record `intendedTxHash` in one place before broadcast.
	// The whole state transition (Requested → Initiated + CurrentTransaction link)
	// is wrapped in one Serializable tx so it commits atomically.
	const sharedTxId = await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					const sharedTx = await tx.transaction.create({
						data: {
							status: TransactionStatus.Pending,
							// `lastCheckedAt: now` debounces wallet-timeouts' first poll by 1
							// minute — comfortably longer than the build/sign/submit window —
							// so the row isn't reaped mid-submit. See createPendingTransaction's
							// note in shared/transition-writer.ts for the full rationale.
							lastCheckedAt: new Date(),
							BlocksWallet: { connect: { id: walletId } },
						},
					});
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
								SmartContractWallet: {
									connect: {
										id: walletId,
									},
								},
								buyerReturnAddress: request.paymentRequest.buyerReturnAddress ?? walletPairing.collectionAddress,
								...connectExistingTransaction(sharedTx.id),
								TransactionHistory: request.paymentRequest.CurrentTransaction
									? {
											connect: {
												id: request.paymentRequest.CurrentTransaction.id,
											},
										}
									: undefined,
							},
						});
					}
					return sharedTx.id;
				},
				{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
			),
		{ label: 'batch-payments-v1-presubmit' },
	);

	logger.info('Batching payments, purchase request initialized');

	// Clamp the lock tx's upper bound to the EARLIEST payByTime in the batch, so
	// the funding tx cannot be included in a block after payByTime. Otherwise a
	// slow build / congested mempool lets it land late and tx-sync marks the
	// request FundsOrDatumInvalid on both sides with funds already locked
	// on-chain (unrecoverable); with the clamp the tx expires and is retried.
	// payByTime is guaranteed non-null by the loop above.
	const minPayByTime = batchedRequests.reduce<bigint>(
		(min, b) => (b.paymentRequest.payByTime! < min ? b.paymentRequest.payByTime! : min),
		batchedRequests[0].paymentRequest.payByTime!,
	);
	const { invalidBefore, invalidAfter } = createTxWindow(convertNetwork(paymentContract.network), {
		constrainAfterMs: minPayByTime,
	});
	unsignedTx.setNetwork(convertNetwork(paymentContract.network));
	unsignedTx.txBuilder.invalidBefore(invalidBefore);
	unsignedTx.txBuilder.invalidHereafter(invalidAfter);

	// build()/signTx run BEFORE submitTx and BEFORE intendedTxHash is recorded — a
	// throw here (insufficient balance, Blockfrost 5xx, serialization) means the tx
	// was NEVER broadcast. Classify as pre-submit-failed so the aggregator reverts +
	// unlocks (requeuing transient causes) instead of stranding the wallet.
	let completeTx: string;
	let signedTx: string;
	try {
		completeTx = await unsignedTx.build();
		logger.info('Batching payments, complete tx built');
		signedTx = await wallet.signTx(completeTx);
		logger.info('Batching payments, tx signed');
	} catch (buildError) {
		logger.warn('batch-payments build/sign failed pre-broadcast; reverting (never submitted)', {
			sharedTxId,
			requestIds,
			error: buildError instanceof Error ? buildError.message : buildError,
		});
		return { status: 'pre-submit-failed', walletId, sharedTxId, requestIds, error: buildError };
	}

	// Funding double-lock guarantee: compute the deterministic txHash + invalid_
	// hereafter slot from the SIGNED body and persist them BEFORE broadcast. If
	// submitTx later throws ambiguously (network/transport failure with unknown
	// chain outcome), funding-reconciliation queries the chain for this exact hash
	// and either promotes it to txHash (tx landed) or waits past invalidHereafterSlot
	// before declaring it provably lost.
	// V1 mesh (beta.96) types resolveTxHash as `any`; pin to string so the hash
	// doesn't poison every downstream object with unsafe-any assignments.
	const intendedTxHash = resolveTxHash(signedTx) as string;
	const invalidHereafterSlot = invalidAfter;
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.transaction.update({
					where: { id: sharedTxId },
					data: {
						intendedTxHash,
						invalidHereafterSlot: BigInt(invalidHereafterSlot),
						lastCheckedAt: new Date(),
					},
				}),
			{ label: 'batch-payments-v1-record-intended' },
		);
	} catch (recordError) {
		// Could not persist the deterministic hash. We have NOT broadcast yet — safe
		// to bail. Without intendedTxHash reconciliation cannot resolve an ambiguous
		// outcome, so we MUST NOT broadcast.
		logger.error('batch-payments could not record intendedTxHash; aborting submit', {
			sharedTxId,
			intendedTxHash,
			error: recordError instanceof Error ? recordError.message : recordError,
		});
		return { status: 'pre-submit-failed', walletId, sharedTxId, requestIds, error: recordError };
	}

	let txHash: string;
	try {
		txHash = await wallet.submitTx(signedTx);
	} catch (submitError) {
		// Definitive node rejection (ledger rejected the body pre-broadcast) → safe
		// to revert. Anything else (5xx, ECONNRESET, timeout) is ambiguous: the tx
		// MAY be on chain, so leave the row Pending with intendedTxHash set and let
		// funding-reconciliation resolve it. Reverting here risks a double-lock.
		if (isDefinitiveNodeRejection(submitError)) {
			logger.warn('batch-payments submit definitively rejected by node', {
				sharedTxId,
				intendedTxHash,
				error: submitError instanceof Error ? submitError.message : submitError,
			});
			return { status: 'submit-rejected', walletId, sharedTxId, intendedTxHash, requestIds, error: submitError };
		}
		logger.warn('batch-payments submit AMBIGUOUS; leaving Pending for reconciliation', {
			sharedTxId,
			intendedTxHash,
			invalidHereafterSlot,
			error: submitError instanceof Error ? submitError.message : submitError,
		});
		return {
			status: 'submit-ambiguous',
			walletId,
			sharedTxId,
			intendedTxHash,
			invalidHereafterSlot,
			requestIds,
			error: submitError,
		};
	}

	// Node accepted the tx. Assert its hash matches the deterministic one we
	// recorded; a mismatch is a Mesh/Cardano bug we must not swallow — recording the
	// wrong hash would leave reconciliation unable to ever resolve the row.
	if (txHash !== intendedTxHash) {
		logger.error('batch-payments node returned divergent txHash; treating as ambiguous', {
			sharedTxId,
			intendedTxHash,
			nodeTxHash: txHash,
		});
		return {
			status: 'submit-ambiguous',
			walletId,
			sharedTxId,
			intendedTxHash,
			invalidHereafterSlot,
			requestIds,
			error: new Error(`Node returned divergent txHash ${txHash} vs intended ${intendedTxHash}`),
		};
	}

	// Non-fatal: the tx is already on chain. A balance-monitor throw must NOT
	// propagate and get the pairing misclassified as ambiguous — the txHash is about
	// to be recorded below.
	try {
		await walletLowBalanceMonitorService.evaluateProjectedHotWalletById({
			hotWalletId: walletId,
			walletAddress: walletPairing.changeAddress,
			walletUtxos: walletPairing.utxos,
			unsignedTx: completeTx,
			checkSource: 'submission',
		});
	} catch (balanceError) {
		logger.warn('batch-payments post-submit balance monitor failed (non-fatal; tx already on chain)', {
			walletId,
			txHash,
			error: balanceError instanceof Error ? balanceError.message : balanceError,
		});
	}

	logger.info('Batching payments, tx submitted', {
		txHash: txHash,
	});

	// Post-submit: the single shared Transaction row receives the txHash. If this
	// fails the tx IS on chain (intendedTxHash catches it via reconciliation), so we
	// surface post-submit-db-failed for the aggregator to retry once more.
	try {
		await retryOnSerializationConflict(
			() =>
				prisma.transaction.update({
					where: { id: sharedTxId },
					data: { txHash },
				}),
			{ label: 'batch-payments-v1-post-submit-hash' },
		);
	} catch (postSubmitError) {
		return { status: 'post-submit-db-failed', walletId, sharedTxId, txHash, requestIds, error: postSubmitError };
	}
	logger.info('Batching payments, purchase request updated');

	return { status: 'succeeded', walletId, sharedTxId, txHash, requestIds };
}

export async function batchLatestPaymentEntriesV1() {
	const maxBatchSize = 10;

	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		// Gate Serializable $transaction through the shared semaphore so the pg
		// connection pool isn't exhausted under scheduler fan-out.
		const paymentContractsWithWalletLocked = await withSerializableSlot(() =>
			retryOnSerializationConflict(
				() =>
					prisma.$transaction(
						async (prisma) => {
							const payByTime = new Date().getTime() + 1000 * 57;
							const paymentContracts = await prisma.paymentSource.findMany({
								where: {
									deletedAt: null,
									paymentSourceType: PaymentSourceType.Web3CardanoV1,
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
									//(deadline is within the next 5 minutes or already past — the seller
									//can never submit in time, so locking funds only forces a refund)
									const maxSubmitResultTime = Date.now() + 1000 * 60 * 5;
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
										await prisma.hotWallet.update({
											where: { id: wallet.id, deletedAt: null },
											data: { lockedAt: new Date() },
										});
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
			),
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
							};
						}),
					);
					const paymentRequestsRemaining = [...paymentRequests];
					const walletPairings = [];

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
							const originalPaidFundsArray = paymentRequest.PaidFunds.map((f) => ({ ...f }));
							const sellerAddress = paymentRequest.SellerWallet.walletAddress;

							const otherUnits = paymentRequest.PaidFunds.filter(
								(amount) => amount.unit.toLowerCase() != '' && amount.unit.toLowerCase() != 'lovelace',
							).length;

							const resultSubmittedEstimateDatum = getDatumFromBlockchainIdentifier({
								buyerAddress: sellerAddress,
								sellerAddress: sellerAddress,
								blockchainIdentifier: paymentRequest.blockchainIdentifier,
								inputHash: paymentRequest.inputHash,
								payByTime: paymentRequest.payByTime!,
								collateralReturnLovelace: 0n,
								resultHash: DUMMY_RESULT_HASH,
								resultTime: BigInt(paymentRequest.submitResultTime),
								unlockTime: BigInt(paymentRequest.unlockTime),
								externalDisputeUnlockTime: BigInt(paymentRequest.externalDisputeUnlockTime),
								newCooldownTimeSeller: BigInt(0),
								newCooldownTimeBuyer: BigInt(0),
								state: SmartContractState.ResultSubmitted,
							});

							const minUtxoResult = calculateMinUtxo({
								datum: resultSubmittedEstimateDatum.value,
								nativeTokenCount: otherUnits,
								coinsPerUtxoSize: protocolParameter.coinsPerUtxoSize,
								includeBuffers: true,
							});

							let overestimatedMinUtxoCost = minUtxoResult.minUtxoLovelace;

							//set min ada required;
							const lovelaceRequired = paymentRequest.PaidFunds.findIndex((amount) => amount.unit.toLowerCase() === '');
							let overpaidLovelace = 0n;
							if (lovelaceRequired == -1) {
								overpaidLovelace = overestimatedMinUtxoCost;
								paymentRequest.PaidFunds.push({
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
							} else if (paymentRequest.PaidFunds[lovelaceRequired].amount < overestimatedMinUtxoCost) {
								overpaidLovelace = overestimatedMinUtxoCost - paymentRequest.PaidFunds[lovelaceRequired].amount;
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

								paymentRequest.PaidFunds.splice(lovelaceRequired, 1);
								paymentRequest.PaidFunds.push({
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
							for (const paymentAmount of paymentRequest.PaidFunds) {
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
								batchedPaymentRequests.push({
									paymentRequest,
									overpaidLovelace,
								});
								//deduct amounts from wallet
								for (const paymentAmount of paymentRequest.PaidFunds) {
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
								paymentRequest.PaidFunds.length = 0;
								paymentRequest.PaidFunds.push(...originalPaidFundsArray);
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

					// Release any candidate wallet that ended up WITHOUT a pairing (no
					// batchable request fit it — insufficient funds, hot-wallet-limit
					// mismatch, or an empty remainder). Every candidate wallet was locked
					// in the Serializable claim above; the per-pairing and outer-catch
					// unlocks only free PAIRED wallets, so without this an unfundable
					// wallet leaks its lock every tick until the stale-lock reaper. Paired
					// wallets are excluded by id (their PendingTransaction is created later
					// inside executeSpecificBatchPayment), and the pendingTransactionId
					// guard avoids touching any wallet already carrying an in-flight tx.
					const pairedWalletIds = new Set(walletPairings.map((pairing) => pairing.walletId));
					const unpairedWalletIds = potentialWallets
						.map((candidateWallet) => candidateWallet.id)
						.filter((walletId) => !pairedWalletIds.has(walletId));
					if (unpairedWalletIds.length > 0) {
						await prisma.hotWallet.updateMany({
							where: {
								id: { in: unpairedWalletIds },
								deletedAt: null,
								type: HotWalletType.Purchasing,
								pendingTransactionId: null,
							},
							data: { lockedAt: null },
						});
					}

					if (walletPairings.length == 0) {
						logger.info('No purchase requests with funds found, skipping');
						return;
					}

					logger.info(`Batching ${walletPairings.length} payments for payment source ${paymentContract.id}`);
					// Each pairing returns a structured BatchOutcome instead of throwing.
					// We must NEVER auto-revert an ambiguous submit (the tx may be on
					// chain), so the aggregator branches per outcome rather than the old
					// blanket "any error → WaitingForManualAction + unlock".
					const pairingByWalletId = new Map(walletPairings.map((pairing) => [pairing.walletId, pairing]));
					const outcomes = await Promise.allSettled(
						walletPairings.map(async (walletPairing): Promise<BatchOutcome> => {
							try {
								return await executeSpecificBatchPayment(walletPairing, paymentContract, blockchainProvider);
							} catch (uncaught) {
								// executeSpecificBatchPayment SHOULD always return an outcome. An
								// uncaught throw is a programmer bug — treat as ambiguous to keep
								// the double-lock guarantee (don't auto-revert request state).
								// Note: V1 has no lock-time placeholder tx, so if the throw happened
								// BEFORE the shared-tx `$transaction` committed there is no Pending row
								// and no intendedTxHash for funding-reconciliation to find (sharedTxId
								// is ''); those requests stay FundsLockingRequested / CurrentTransaction
								// null and simply re-batch once wallet-timeouts frees the wallet (its
								// orphan branch, ~lock-timeout latency — slower than the reconciler
								// path, but no fund risk since nothing was broadcast).
								logger.error('batch-payments inner threw instead of returning outcome — treating as ambiguous', {
									walletId: walletPairing.walletId,
									error: uncaught instanceof Error ? { message: uncaught.message, stack: uncaught.stack } : uncaught,
								});
								return {
									status: 'submit-ambiguous',
									walletId: walletPairing.walletId,
									sharedTxId: '',
									intendedTxHash: '',
									invalidHereafterSlot: 0,
									requestIds: walletPairing.batchedRequests.map((b) => b.paymentRequest.id),
									error: uncaught,
								};
							}
						}),
					);

					for (const settled of outcomes) {
						if (settled.status === 'rejected') {
							logger.error('batch-payments unexpected outer rejection', {
								reason: settled.reason instanceof Error ? settled.reason.message : String(settled.reason),
							});
							continue;
						}
						const outcome = settled.value;
						switch (outcome.status) {
							case 'succeeded':
								// Wallet stays locked until tx-sync sees the confirmation — existing
								// behavior. Nothing to do.
								logger.info('batch-payments pairing succeeded', {
									walletId: outcome.walletId,
									sharedTxId: outcome.sharedTxId,
									txHash: outcome.txHash,
									requestCount: outcome.requestIds.length,
								});
								break;

							case 'post-submit-db-failed':
								// txHash IS on chain and known; one last attempt to persist it. If
								// this fails too, funding-reconciliation resolves via the
								// intendedTxHash recorded pre-submit.
								logger.warn('batch-payments post-submit DB failed; retrying txHash persistence', {
									walletId: outcome.walletId,
									sharedTxId: outcome.sharedTxId,
									txHash: outcome.txHash,
									error: outcome.error instanceof Error ? outcome.error.message : outcome.error,
								});
								try {
									await retryOnSerializationConflict(
										() =>
											prisma.transaction.update({
												where: { id: outcome.sharedTxId },
												data: { txHash: outcome.txHash },
											}),
										{ label: 'batch-payments-v1-post-submit-retry-outer' },
									);
								} catch (retryError) {
									logger.error(
										'batch-payments post-submit DB retry also failed; reconciliation will resolve via intendedTxHash',
										{ walletId: outcome.walletId, sharedTxId: outcome.sharedTxId, error: retryError },
									);
								}
								break;

							case 'submit-rejected':
							case 'pre-submit-failed': {
								// Definitive failure with no on-chain effect (or no broadcast
								// attempted). Safe to revert request state + unlock the wallet. A
								// transient pre-submit cause (Blockfrost 5xx / transport drop during
								// build) is not a real failure — requeue to FundsLockingRequested so
								// the next tick re-batches instead of parking an operator ticket.
								const isRetryableTransient =
									outcome.status === 'pre-submit-failed' && isTransientPreSubmitError(outcome.error);
								const errNote =
									outcome.status === 'submit-rejected'
										? 'Batching payments rejected by node: ' + interpretBlockchainError(outcome.error)
										: 'Batching payments pre-submit failure: ' +
											(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
								logger.warn(
									`batch-payments pairing ${outcome.status}; ${
										isRetryableTransient ? 'transient — requeuing for retry' : 'reverting + unlocking'
									}`,
									{ walletId: outcome.walletId, sharedTxId: outcome.sharedTxId },
								);
								const batchedRequestsForRevert = pairingByWalletId.get(outcome.walletId)?.batchedRequests ?? [];
								for (const batchedRequest of batchedRequestsForRevert) {
									await prisma.purchaseRequest.update({
										where: { id: batchedRequest.paymentRequest.id },
										data: {
											ActionHistory: {
												connect: { id: batchedRequest.paymentRequest.nextActionId },
											},
											NextAction: {
												create: isRetryableTransient
													? {
															requestedAction: PurchasingAction.FundsLockingRequested,
															errorType: null,
															errorNote: null,
														}
													: {
															requestedAction: PurchasingAction.WaitingForManualAction,
															errorType: PurchaseErrorType.Unknown,
															errorNote: errNote,
														},
											},
											// The rolled-back shared tx is recorded in TransactionHistory on BOTH
											// branches so it is never left dangling (the error-state-recovery
											// endpoint rebuilds currentTransactionId from TransactionHistory, so a
											// tx that is only referenced as CurrentTransaction gets orphaned on
											// recovery). Additionally, the requeue path MUST clear
											// CurrentTransaction: the batcher re-selects on
											// `CurrentTransaction: { is: null }`, so a requeued row that kept its
											// rolled-back tx would never re-batch (the latent stranding the V2
											// path still has). Manual-action rows keep it as CurrentTransaction
											// (matches V2); the tx never broadcast, so there is no on-chain
											// artifact either way.
											TransactionHistory: { connect: { id: outcome.sharedTxId } },
											...(isRetryableTransient ? { CurrentTransaction: { disconnect: true } } : {}),
										},
									});
								}
								if (outcome.sharedTxId !== '') {
									try {
										await prisma.transaction.update({
											where: { id: outcome.sharedTxId },
											data: { status: TransactionStatus.RolledBack },
										});
									} catch (rollbackError) {
										logger.warn('batch-payments rollback mark failed (non-fatal)', {
											sharedTxId: outcome.sharedTxId,
											error: rollbackError instanceof Error ? rollbackError.message : rollbackError,
										});
									}
								}
								await prisma.hotWallet.update({
									where: { id: outcome.walletId, deletedAt: null },
									data: {
										lockedAt: null,
										PendingTransaction: { disconnect: true },
									},
								});
								break;
							}

							case 'submit-ambiguous':
								// CRITICAL: do NOT revert request state, do NOT mark RolledBack, do
								// NOT unlock the wallet. The tx MAY be on chain. The shared
								// Transaction row keeps intendedTxHash + invalidHereafterSlot set;
								// funding-reconciliation resolves it once the chain reports
								// definitively. The wallet stays locked → wallet-timeouts cannot
								// recover it until reconciliation flips the tx status (or tx-sync
								// confirms it on chain).
								logger.warn('batch-payments pairing AMBIGUOUS; leaving for funding-reconciliation', {
									walletId: outcome.walletId,
									sharedTxId: outcome.sharedTxId,
									intendedTxHash: outcome.intendedTxHash,
									invalidHereafterSlot: outcome.invalidHereafterSlot,
									requestCount: outcome.requestIds.length,
									error: outcome.error instanceof Error ? outcome.error.message : outcome.error,
								});
								break;
						}
					}
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

					// Rows that advanced to FundsLockingInitiated but never reached the
					// pre-submit intendedTxHash record (both hashes NULL ⇒ no tx left the
					// host). The wallet-unlock loop below rolls back their shared tx, so
					// funding-reconciliation can't resolve them (it polls by
					// intendedTxHash); revert to FundsLockingRequested so the next tick
					// re-batches them.
					const orphanedInitiatedRequests = await prisma.purchaseRequest.findMany({
						where: {
							id: { in: potentiallyFailedPurchaseRequests.map((x) => x.id) },
							NextAction: {
								requestedAction: PurchasingAction.FundsLockingInitiated,
							},
							CurrentTransaction: {
								is: {
									intendedTxHash: null,
									txHash: null,
								},
							},
						},
						include: { NextAction: true, CurrentTransaction: true },
					});
					if (orphanedInitiatedRequests.length > 0) {
						logger.warn('batch-payments outer-catch reverting orphaned FundsLockingInitiated rows', {
							count: orphanedInitiatedRequests.length,
							ids: orphanedInitiatedRequests.map((r) => r.id),
						});
					}

					// Outer-catch wallet unlock — every candidate wallet that the shared-tx
					// creation touched now carries a PendingTransaction, so a bare
					// `pendingTransactionId: null` filter would match none of them. Walk
					// each candidate, roll back its pending tx, disconnect, then clear
					// lockedAt.
					await Promise.all(
						paymentContract.HotWallets.map(async (candidateWallet) => {
							const fresh = await prisma.hotWallet.findUnique({
								where: { id: candidateWallet.id, deletedAt: null },
								select: {
									pendingTransactionId: true,
									type: true,
									PendingTransaction: { select: { status: true, intendedTxHash: true, txHash: true } },
								},
							});
							if (fresh == null || fresh.type !== HotWalletType.Purchasing) return;
							// CRITICAL double-lock guard: only roll back + unlock a pending tx that
							// PROVABLY never broadcast (both hashes null). If a per-outcome revert
							// above threw and jumped us here while a sibling pairing had already
							// succeeded (txHash set, awaiting tx-sync confirmation) or returned
							// submit-ambiguous (intendedTxHash set, txHash null, tx MAY be on
							// chain), that wallet's shared tx is still Pending. Rolling it back
							// would hide it from funding-reconciliation / tx-sync (both key on
							// status: Pending) AND free the wallet into a double-lock. Leave any tx
							// with either hash set Pending + locked.
							const pendingTx = fresh.PendingTransaction;
							if (
								pendingTx != null &&
								pendingTx.status === TransactionStatus.Pending &&
								(pendingTx.intendedTxHash != null || pendingTx.txHash != null)
							) {
								logger.warn(
									'batch-payments outer-catch: preserving possibly-on-chain funding tx (leaving Pending + wallet locked)',
									{
										walletId: candidateWallet.id,
										pendingTransactionId: fresh.pendingTransactionId,
										hasTxHash: pendingTx.txHash != null,
										hasIntendedTxHash: pendingTx.intendedTxHash != null,
									},
								);
								return;
							}
							if (fresh.pendingTransactionId != null) {
								try {
									await prisma.transaction.update({
										where: { id: fresh.pendingTransactionId },
										data: { status: TransactionStatus.RolledBack },
									});
								} catch (rollbackError) {
									logger.warn('batch-payments outer-catch pending-tx rollback failed (non-fatal)', {
										walletId: candidateWallet.id,
										pendingTransactionId: fresh.pendingTransactionId,
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

					// Revert the orphans AFTER the wallet-unlock loop, so the next tick
					// never sees Requested while the wallet still holds the (now
					// rolled-back) shared tx.
					await Promise.allSettled(
						orphanedInitiatedRequests.map(async (r) => {
							await prisma.purchaseRequest.update({
								where: { id: r.id },
								data: {
									ActionHistory: {
										connect: { id: r.nextActionId },
									},
									NextAction: {
										create: {
											requestedAction: PurchasingAction.FundsLockingRequested,
											errorType: null,
											errorNote: null,
										},
									},
									CurrentTransaction: { disconnect: true },
									TransactionHistory: r.CurrentTransaction ? { connect: { id: r.CurrentTransaction.id } } : undefined,
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
		release?.();
	}
}
