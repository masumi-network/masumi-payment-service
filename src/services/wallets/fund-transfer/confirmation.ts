import { Prisma, Network, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { errorToString } from '@masumi/payment-core/error-string-convert';
import { CONFIG } from '@masumi/payment-core/config';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { lookupChainTx } from '@/services/shared/chain-tx-lookup';

const MAX_CONFIRMATIONS_PER_CYCLE = 50;

/**
 * Wait this many slots past `invalidHereafterSlot` before declaring a not-found
 * tx permanently dead. Matches `RECONCILE_SLOT_GRACE` in
 * `funding-reconciliation`, so a fund transfer and the shared reconciler use
 * the same safe boundary and cannot disagree about when a body can no longer
 * land.
 */
const SLOT_GRACE = 60;

type InFlightTransfer = Prisma.WalletFundTransferGetPayload<{
	include: {
		Transaction: {
			select: {
				id: true;
				txHash: true;
				intendedTxHash: true;
				status: true;
				invalidHereafterSlot: true;
				createdAt: true;
			};
		};
		HotWallet: {
			select: {
				id: true;
				PaymentSource: {
					select: { network: true; PaymentSourceConfig: { select: { rpcProviderApiKey: true } } };
				};
			};
		};
	};
}>;

async function fetchCurrentSlot(network: Network, apiKey: string): Promise<number | null> {
	try {
		const latest = await getBlockfrostInstance(network, apiKey).blocksLatest();
		const slot = latest?.slot;
		return typeof slot === 'number' ? slot : null;
	} catch (error) {
		logger.warn('fund-transfer confirmation: blocksLatest failed', { error: errorToString(error) });
		return null;
	}
}

/** Record a checked-but-unresolved probe so the poll interval advances. */
async function touch(transferId: string): Promise<void> {
	await prisma.walletFundTransfer.updateMany({
		where: { id: transferId },
		data: { lastCheckedAt: new Date() },
	});
}

/**
 * Mark the transfer confirmed and release its wallet. Every write is guarded on
 * `transactionId` / `pendingTransactionId`, so if the shared machinery already
 * advanced the row (or the wallet was reassigned to another flow), the guarded
 * updates simply match nothing — this can never steal a lock it no longer owns.
 */
async function confirmTransfer(transfer: InFlightTransfer, transactionId: string, txHash: string): Promise<void> {
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					await tx.transaction.updateMany({
						where: { id: transactionId, status: TransactionStatus.Pending },
						data: { txHash, status: TransactionStatus.Confirmed, lastCheckedAt: new Date() },
					});
					await tx.walletFundTransfer.updateMany({
						where: { id: transfer.id, transactionId },
						data: { status: TransactionStatus.Confirmed, txHash, lastCheckedAt: new Date() },
					});
					await tx.hotWallet.updateMany({
						where: { id: transfer.HotWallet.id, pendingTransactionId: transactionId },
						data: { lockedAt: null, pendingTransactionId: null },
					});
				},
				{ isolationLevel: 'Serializable' },
			),
		{ label: 'fund-transfer-confirm' },
	);
}

/**
 * Mark the transfer failed/rolled-back and release its wallet. The Transaction
 * is marked RolledBack (not deleted) so the audit link survives; the guards
 * make a concurrent resolution by the shared reconciler a no-op.
 */
async function failTransfer(
	transfer: InFlightTransfer,
	transactionId: string,
	transferStatus: TransactionStatus,
	errorNote: string,
): Promise<void> {
	await withSerializableSlotRetry(
		() =>
			prisma.$transaction(
				async (tx) => {
					await tx.transaction.updateMany({
						where: { id: transactionId, status: TransactionStatus.Pending },
						data: { status: TransactionStatus.RolledBack, lastCheckedAt: new Date() },
					});
					await tx.walletFundTransfer.updateMany({
						where: { id: transfer.id, transactionId },
						data: { status: transferStatus, errorNote, lastCheckedAt: new Date() },
					});
					await tx.hotWallet.updateMany({
						where: { id: transfer.HotWallet.id, pendingTransactionId: transactionId },
						data: { lockedAt: null, pendingTransactionId: null },
					});
				},
				{ isolationLevel: 'Serializable' },
			),
		{ label: 'fund-transfer-fail' },
	);
}

/** Mirror a Transaction the shared machinery already resolved onto the transfer. */
async function mirrorTerminal(
	transfer: InFlightTransfer,
	transactionId: string,
	transferStatus: TransactionStatus,
	txHash: string | null,
	errorNote: string | null,
): Promise<void> {
	await retryOnSerializationConflict(
		() =>
			prisma.$transaction(
				async (tx) => {
					await tx.walletFundTransfer.updateMany({
						where: { id: transfer.id, transactionId },
						data: { status: transferStatus, txHash, errorNote, lastCheckedAt: new Date() },
					});
					// Best-effort release in case the shared path advanced the
					// Transaction but did not clear this wallet's lock.
					await tx.hotWallet.updateMany({
						where: { id: transfer.HotWallet.id, pendingTransactionId: transactionId },
						data: { lockedAt: null, pendingTransactionId: null },
					});
				},
				{ isolationLevel: 'Serializable' },
			),
		{ label: 'fund-transfer-mirror' },
	);
}

async function reconcileOne(transfer: InFlightTransfer): Promise<void> {
	const tx = transfer.Transaction;
	// transactionId is set (the query filters on it) and the FK nulls on delete,
	// so a present transactionId always resolves to a Transaction row.
	if (tx == null) return;

	// The shared machinery (tx-sync rollback, funding-reconciliation) may resolve
	// the Transaction first. Mirror its terminal decision onto the transfer.
	if (tx.status === TransactionStatus.Confirmed) {
		await mirrorTerminal(transfer, tx.id, TransactionStatus.Confirmed, tx.txHash, null);
		return;
	}
	if (tx.status === TransactionStatus.RolledBack) {
		await mirrorTerminal(
			transfer,
			tx.id,
			TransactionStatus.FailedViaTimeout,
			tx.txHash,
			'Transaction rolled back on chain',
		);
		return;
	}

	const network = transfer.HotWallet.PaymentSource.network;
	const apiKey = transfer.HotWallet.PaymentSource.PaymentSourceConfig.rpcProviderApiKey;

	// Probe the broadcast hash if we have one, else the intended hash (ambiguous
	// submit). A hash of neither means the body was never signed.
	const hashToProbe = tx.txHash ?? tx.intendedTxHash;

	if (hashToProbe == null) {
		// Never-broadcast orphan: the process died between claiming the wallet and
		// recording intendedTxHash, so nothing was signed and nothing can be on
		// chain. The shared reconciler skips these (it requires intendedTxHash),
		// and wallet-timeouts leaves the wallet locked (it has a PendingTransaction),
		// so this job is the only thing that recovers them — but only once past the
		// lock timeout, never during the build/sign window.
		const abandonedBefore = new Date(Date.now() - CONFIG.WALLET_LOCK_TIMEOUT_INTERVAL);
		if (tx.createdAt < abandonedBefore) {
			await failTransfer(
				transfer,
				tx.id,
				TransactionStatus.FailedViaTimeout,
				'Never broadcast; abandoned past lock timeout',
			);
		}
		return;
	}

	const result = await lookupChainTx({ network, rpcProviderApiKey: apiKey, txHash: hashToProbe });

	if (result === 'found') {
		// On chain. If we probed intendedTxHash (ambiguous submit), this promotes
		// it to the confirmed txHash in the same write.
		await confirmTransfer(transfer, tx.id, hashToProbe);
		return;
	}

	if (result === 'transient-error') {
		// Indexer unreachable — act on nothing, which is the only safe default
		// when funds are involved. Retry next cycle.
		await touch(transfer.id);
		return;
	}

	// not-found. Only safe to declare dead once the ledger provably can no longer
	// include the body: past invalidHereafterSlot plus grace. Before that, a
	// not-found is just "not indexed yet".
	if (tx.invalidHereafterSlot == null) {
		logger.warn('fund-transfer confirmation: not-found but invalidHereafterSlot is null; leaving for manual triage', {
			transferId: transfer.id,
			transactionId: tx.id,
		});
		await touch(transfer.id);
		return;
	}

	const currentSlot = await fetchCurrentSlot(network, apiKey);
	if (currentSlot == null) {
		await touch(transfer.id);
		return;
	}
	if (currentSlot <= Number(tx.invalidHereafterSlot) + SLOT_GRACE) {
		// Still within TTL (plus grace); the tx could yet land. Wait.
		await touch(transfer.id);
		return;
	}

	await failTransfer(transfer, tx.id, TransactionStatus.FailedViaTimeout, 'Not on chain past invalid-hereafter slot');
}

/**
 * Resolve in-flight fund transfers against the chain: confirm the ones that
 * landed, release the ones that provably cannot, and recover never-broadcast
 * orphans. Reaches transfers via their linked Transaction; the shared
 * funding-reconciliation cron independently resolves the ambiguous-submit case,
 * and every write here is ownership-guarded so the two never corrupt each other.
 */
export async function checkFundTransferConfirmations(): Promise<void> {
	const inFlight = await prisma.walletFundTransfer.findMany({
		where: { status: TransactionStatus.Pending, transactionId: { not: null } },
		take: MAX_CONFIRMATIONS_PER_CYCLE,
		include: {
			Transaction: {
				select: {
					id: true,
					txHash: true,
					intendedTxHash: true,
					status: true,
					invalidHereafterSlot: true,
					createdAt: true,
				},
			},
			HotWallet: {
				select: {
					id: true,
					PaymentSource: {
						select: { network: true, PaymentSourceConfig: { select: { rpcProviderApiKey: true } } },
					},
				},
			},
		},
	});

	await Promise.allSettled(
		inFlight.map(async (transfer) => {
			try {
				await reconcileOne(transfer);
			} catch (error) {
				logger.error(`fund-transfer confirmation failed for ${transfer.id}: ${errorToString(error)}`);
			}
		}),
	);
}
