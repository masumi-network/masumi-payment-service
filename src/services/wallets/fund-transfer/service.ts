import { Prisma, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { errorToString } from '@masumi/payment-core/error-string-convert';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { buildAndSignFundTransferTx } from './transaction-builder';
import { readFundTransferAssets } from './assets';

const mutex = new Mutex();

/**
 * Rows scanned per cycle. The actual concurrency is bounded far tighter by the
 * shared Serializable semaphore (`withSerializableSlotRetry`); this only caps
 * how many rows one tick pulls into memory.
 */
const MAX_TRANSFERS_PER_CYCLE = 50;

type ScannedFundTransfer = Prisma.WalletFundTransferGetPayload<{
	include: {
		HotWallet: {
			include: {
				Secret: true;
				PaymentSource: { include: { PaymentSourceConfig: true } };
			};
		};
	};
}>;

type ClaimErrorCode = 'WALLET_UNAVAILABLE' | 'TRANSFER_ALREADY_CLAIMED' | 'LEASE_LOST';

function claimError(code: ClaimErrorCode): Error & { code: ClaimErrorCode } {
	return Object.assign(new Error(code), { code });
}

function claimCode(error: unknown): ClaimErrorCode | undefined {
	if (error instanceof Error && 'code' in error) {
		return (error as { code?: ClaimErrorCode }).code;
	}
	return undefined;
}

/**
 * Fail a transfer and release its wallet lock, guarded so it only ever clears
 * the lock THIS transfer's Transaction still holds. The guard is what stops a
 * failing transfer from stealing a lock that a timeout-recovery path or another
 * flow has since handed to a different Transaction.
 */
async function failTransferAndRelease(params: {
	transferId: string;
	transactionId: string;
	hotWalletId: string;
	status: TransactionStatus;
	errorNote: string;
}): Promise<void> {
	const { transferId, transactionId, hotWalletId, status, errorNote } = params;
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					await tx.walletFundTransfer.updateMany({
						where: { id: transferId, transactionId },
						data: { status, errorNote, lastCheckedAt: new Date() },
					});
					// Only release the lock this transaction owns. A mismatch means
					// recovery already reassigned the wallet — leave it alone.
					await tx.hotWallet.updateMany({
						where: { id: hotWalletId, pendingTransactionId: transactionId },
						data: { lockedAt: null, pendingTransactionId: null },
					});
					// Drop the orphaned Transaction so funding-reconciliation never
					// picks it up. Safe: this runs only when the body provably never
					// reached the chain.
					await tx.transaction.deleteMany({
						where: { id: transactionId, txHash: null, status: TransactionStatus.Pending },
					});
				},
				{ isolationLevel: 'Serializable' },
			),
		{ label: 'fund-transfer-fail-release' },
	);
}

/**
 * Process one pending fund transfer end to end.
 *
 * Ordering mirrors the funding double-lock guarantee in
 * `packages/payment-source-v2/src/services/purchases/batch-payments/service.ts`:
 * claim the wallet with a Transaction row, build+sign WITHOUT broadcasting,
 * persist intendedTxHash + invalidHereafterSlot, and only THEN submit. A submit
 * that throws is classified — a definitive node rejection is safe to revert, an
 * ambiguous failure (5xx/timeout) is left Pending for the confirmation job and
 * the shared funding-reconciliation worker to resolve against the chain. This
 * is what prevents the "money sent, recorded failed, wallet re-used" hazard the
 * previous submit-then-record ordering allowed.
 */
async function processSingleFundTransfer(transfer: ScannedFundTransfer): Promise<void> {
	const wallet = transfer.HotWallet;
	const network = wallet.PaymentSource.network;
	const rpcProviderApiKey = wallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;
	const encryptedMnemonic = wallet.Secret.encryptedMnemonic;

	// Step 1 — claim. Create the Transaction that will carry this transfer's
	// on-chain lifecycle and take the wallet lock atomically. Reusing
	// pendingTransactionId (not a private column) is what makes the lock visible
	// to the stale-lock reaper, lockAndQueryPayments, swaps and reconciliation.
	let transactionId: string;
	try {
		transactionId = await withSerializableSlotRetry(
			() =>
				prisma.$transaction(
					async (tx) => {
						const newTx = await tx.transaction.create({
							data: { txHash: null, status: TransactionStatus.Pending },
						});

						// The predicate IS the lock acquisition. Two ticks may both read
						// the wallet as free, but only one moves it from free to owned.
						const walletClaim = await tx.hotWallet.updateMany({
							where: {
								id: wallet.id,
								deletedAt: null,
								lockedAt: null,
								pendingTransactionId: null,
								pendingSwapTransactionId: null,
							},
							data: { lockedAt: new Date(), pendingTransactionId: newTx.id },
						});
						if (walletClaim.count !== 1) throw claimError('WALLET_UNAVAILABLE');

						const transferClaim = await tx.walletFundTransfer.updateMany({
							where: { id: transfer.id, status: TransactionStatus.Pending, transactionId: null },
							data: { transactionId: newTx.id },
						});
						if (transferClaim.count !== 1) throw claimError('TRANSFER_ALREADY_CLAIMED');

						return newTx.id;
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-transfer-claim' },
		);
	} catch (error) {
		const code = claimCode(error);
		if (code === 'WALLET_UNAVAILABLE') {
			logger.info(`FundTransfer ${transfer.id}: wallet ${wallet.id} busy, retrying next cycle`);
			return;
		}
		if (code === 'TRANSFER_ALREADY_CLAIMED') {
			logger.info(`FundTransfer ${transfer.id}: already claimed by another worker`);
			return;
		}
		throw error;
	}

	// Step 2 — build + sign WITHOUT broadcasting. A throw here means nothing was
	// ever sent, so reverting (unlock + drop the Transaction + fail) is safe.
	let signed;
	try {
		signed = await buildAndSignFundTransferTx({
			encryptedMnemonic,
			network,
			rpcProviderApiKey,
			toAddress: transfer.toAddress,
			assets: readFundTransferAssets(transfer.lovelaceAmount, transfer.assets),
		});
	} catch (error) {
		const errorMsg = interpretBlockchainError(error);
		logger.error(`FundTransfer ${transfer.id}: build/sign failed pre-broadcast; reverting: ${errorMsg}`);
		await failTransferAndRelease({
			transferId: transfer.id,
			transactionId,
			hotWalletId: wallet.id,
			status: TransactionStatus.FailedViaManualReset,
			errorNote: errorMsg,
		});
		return;
	}

	// Step 3 — persist intendedTxHash + invalidHereafterSlot BEFORE broadcast,
	// re-fencing the lease. If a timeout/recovery path won the wallet while
	// build/sign was awaiting network I/O, discard the signed body rather than
	// broadcasting under a lease we no longer hold.
	try {
		await withSerializableSlotRetry(
			() =>
				prisma.$transaction(
					async (tx) => {
						const lease = await tx.hotWallet.updateMany({
							where: { id: wallet.id, deletedAt: null, pendingTransactionId: transactionId },
							data: { lockedAt: new Date() },
						});
						if (lease.count !== 1) throw claimError('LEASE_LOST');

						const recorded = await tx.transaction.updateMany({
							where: { id: transactionId, status: TransactionStatus.Pending, txHash: null, intendedTxHash: null },
							data: {
								intendedTxHash: signed.intendedTxHash,
								invalidHereafterSlot: BigInt(signed.invalidHereafterSlot),
								lastCheckedAt: new Date(),
							},
						});
						if (recorded.count !== 1) throw claimError('LEASE_LOST');
					},
					{ isolationLevel: 'Serializable' },
				),
			{ label: 'fund-transfer-record-intended' },
		);
	} catch (error) {
		if (claimCode(error) === 'LEASE_LOST') {
			// The lease moved on while we were signing. Do NOT broadcast and do NOT
			// revert — whoever holds the wallet now owns the outcome. Discard.
			logger.warn(`FundTransfer ${transfer.id}: lease lost before recording intendedTxHash; discarding signed body`);
			return;
		}
		const errorMsg = interpretBlockchainError(error);
		logger.error(`FundTransfer ${transfer.id}: could not record intendedTxHash; reverting: ${errorMsg}`);
		await failTransferAndRelease({
			transferId: transfer.id,
			transactionId,
			hotWalletId: wallet.id,
			status: TransactionStatus.FailedViaManualReset,
			errorNote: errorMsg,
		});
		return;
	}

	// Step 4 — broadcast. Classify a throw: definitive rejection reverts; an
	// ambiguous failure leaves everything Pending for reconciliation.
	let txHash: string;
	try {
		txHash = await signed.submit();
	} catch (error) {
		const errorMsg = interpretBlockchainError(error);
		if (isDefinitiveNodeRejection(error)) {
			logger.warn(`FundTransfer ${transfer.id}: submit definitively rejected; reverting: ${errorMsg}`);
			await failTransferAndRelease({
				transferId: transfer.id,
				transactionId,
				hotWalletId: wallet.id,
				status: TransactionStatus.FailedViaManualReset,
				errorNote: errorMsg,
			});
			return;
		}
		// Ambiguous: the tx MAY be on chain. Leave the wallet locked and the
		// Transaction Pending with intendedTxHash set. The confirmation job
		// resolves it against the chain, reverting only once invalidHereafterSlot
		// has provably passed. NEVER auto-fail here — a single-use body that
		// landed would otherwise be recorded failed with funds already gone.
		logger.warn(`FundTransfer ${transfer.id}: submit AMBIGUOUS; leaving Pending for reconciliation: ${errorMsg}`);
		return;
	}

	if (txHash !== signed.intendedTxHash) {
		// The node reported a hash we did not compute. Trust neither; let the
		// confirmation job settle it against the chain rather than recording a
		// hash that may not match the body we signed.
		logger.error(
			`FundTransfer ${transfer.id}: node txHash ${txHash} diverged from intendedTxHash ${signed.intendedTxHash}; deferring to reconciliation`,
		);
		return;
	}

	// Step 5 — record the broadcast on both the Transaction (source of truth)
	// and the transfer (denormalized). The wallet stays locked until the
	// confirmation job sees the tx confirmed or provably rolled back.
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					await tx.transaction.updateMany({
						where: { id: transactionId, status: TransactionStatus.Pending },
						data: { txHash, lastCheckedAt: new Date() },
					});
					await tx.walletFundTransfer.updateMany({
						where: { id: transfer.id, transactionId },
						data: { txHash },
					});
				},
				{ isolationLevel: 'Serializable' },
			),
		{ label: 'fund-transfer-record-broadcast' },
	);

	logger.info(`FundTransfer ${transfer.id} submitted`, { txHash });
}

/**
 * Scan for pending fund transfers and process each. Guarded by an in-process
 * mutex so overlapping scheduler ticks in ONE replica do not double-scan; the
 * per-transfer Serializable claim is what makes it safe across replicas.
 */
export async function processFundTransfers(): Promise<void> {
	let release: MutexInterface.Releaser;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (error) {
		logger.info('processFundTransfers already running; skipping tick', { error: errorToString(error) });
		return;
	}

	try {
		// Only rows with no Transaction yet, on a wallet that is currently free.
		// The claim re-checks all of this atomically, so a wallet that becomes
		// busy between this read and the claim is simply skipped.
		const pendingTransfers = await prisma.walletFundTransfer.findMany({
			where: {
				status: TransactionStatus.Pending,
				transactionId: null,
				HotWallet: { lockedAt: null, pendingTransactionId: null, deletedAt: null },
			},
			take: MAX_TRANSFERS_PER_CYCLE,
			include: {
				HotWallet: {
					include: {
						Secret: true,
						PaymentSource: { include: { PaymentSourceConfig: true } },
					},
				},
			},
		});

		await Promise.allSettled(
			pendingTransfers.map(async (transfer) => {
				try {
					await processSingleFundTransfer(transfer);
				} catch (error) {
					// A throw that escapes processSingleFundTransfer is an unexpected
					// bug, not a submit failure. Do NOT blindly mark the transfer
					// failed and unlock the wallet here: the old catch-all did exactly
					// that and could unlock a wallet whose tx was already on chain.
					// Log and leave state intact; the confirmation job and the
					// stale-lock machinery recover any lock this left behind.
					logger.error(`FundTransfer ${transfer.id} unexpected error: ${errorToString(error)}`);
				}
			}),
		);
	} catch (error) {
		logger.error(`Error in processFundTransfers: ${errorToString(error)}`);
	} finally {
		release();
	}
}
