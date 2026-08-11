/**
 * The bounded ledger of confirmed in-head transactions this process retains.
 *
 * Deliberately a window, not an archive: a durable cursor marks how far
 * reconciliation has drained, unreconciled causal evidence is never evicted,
 * the current snapshot's producer transactions are pinned (their CBOR is what
 * fanout references are proven against), and everything else competes under
 * explicit count and byte budgets. When the budgets cannot hold a full replay
 * page, the ledger reports truncation and the replay fails closed until the
 * cursor advances — it never silently drops evidence.
 */

import { resolveTxHash } from '@meshsdk/core';
import { CircularBuffer, setsEqual } from './node-frames';
import { HydraProtocolError } from './errors';
import { canonicalHydraTransactionIdSchema, historySnapshotConfirmedMessageSchema } from './schemas';
import { HydraConfirmedTransaction } from './types';
import { type VerifiedHydraSnapshot } from './snapshot-verification';

type SnapshotConfirmedMessage = ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>;

export function compareConfirmedTransactions(a: HydraConfirmedTransaction, b: HydraConfirmedTransaction): number {
	const sequenceDifference =
		(a.snapshotSequence ?? Number.MAX_SAFE_INTEGER) - (b.snapshotSequence ?? Number.MAX_SAFE_INTEGER);
	if (sequenceDifference !== 0) return sequenceDifference;
	const indexDifference = a.snapshotTransactionIndex - b.snapshotTransactionIndex;
	if (indexDifference !== 0) return indexDifference;
	return a.txId.localeCompare(b.txId);
}

export interface ConfirmedLedgerConfig {
	/** Explicit fail-closed replay cap; unresolved causal evidence is never evicted. */
	maxUnreconciledTransactions: number;
	/** Explicit aggregate budget for retained confirmation CBOR. */
	maxRetainedTransactionCborBytes: number;
	/** Durable high-water mark; replay entries at/before it are parsed but not retained. */
	reconciledHistoryCursor?: { snapshotSequence: number; snapshotTransactionIndex: number };
}

export class ConfirmedTransactionLedger {
	private readonly _confirmedTransactions = new Map<string, HydraConfirmedTransaction>();
	private readonly _unreconciledConfirmedTransactions = new Map<string, HydraConfirmedTransaction>();
	private readonly _txCircularBuffer = new CircularBuffer<string>(10000);
	private _currentSnapshotProducerTxIds = new Set<string>();
	private _currentSnapshotProducerSnapshotNumber: number | undefined;
	private _cursorPrefixProducerTxIds = new Set<string>();
	private _reconciledHistoryCursor: { snapshotSequence: number; snapshotTransactionIndex: number } | undefined;
	private readonly _maxUnreconciledTransactions: number;
	private readonly _maxRetainedTransactionCborBytes: number;

	constructor(config: ConfirmedLedgerConfig) {
		this._maxUnreconciledTransactions = config.maxUnreconciledTransactions;
		this._maxRetainedTransactionCborBytes = config.maxRetainedTransactionCborBytes;
		this._reconciledHistoryCursor = config.reconciledHistoryCursor ? { ...config.reconciledHistoryCursor } : undefined;
	}

	hasConfirmed(txHash: string): boolean {
		return this._txCircularBuffer.getBuffer().includes(txHash);
	}

	getConfirmedTransaction(txHash: string): HydraConfirmedTransaction | null {
		return this._confirmedTransactions.get(txHash) ?? this._unreconciledConfirmedTransactions.get(txHash) ?? null;
	}

	getAllConfirmedSorted(): HydraConfirmedTransaction[] {
		return [...this._confirmedTransactions.values()].sort(compareConfirmedTransactions);
	}

	getUnreconciledSorted(): HydraConfirmedTransaction[] {
		return [...this._unreconciledConfirmedTransactions.values()].sort(compareConfirmedTransactions);
	}

	get hasUnreconciled(): boolean {
		return this._unreconciledConfirmedTransactions.size > 0;
	}

	/**
	 * Advance the durable cursor past the oldest unreconciled transaction.
	 * Strictly in history order and strictly monotonic — the cursor is what
	 * makes it safe to not retain the prefix on the next replay.
	 */
	markReconciled(txHash: string): void {
		const first = this.getUnreconciledSorted()[0];
		if (!first) return;
		if (first.txId !== txHash) {
			throw new HydraProtocolError('Hydra confirmed transactions must be reconciled in history order');
		}
		if (first.snapshotSequence == null) {
			throw new HydraProtocolError('Hydra history evidence cannot advance a cursor without a sequence');
		}
		const nextCursor = {
			snapshotSequence: first.snapshotSequence,
			snapshotTransactionIndex: first.snapshotTransactionIndex,
		};
		if (
			this._reconciledHistoryCursor &&
			(nextCursor.snapshotSequence < this._reconciledHistoryCursor.snapshotSequence ||
				(nextCursor.snapshotSequence === this._reconciledHistoryCursor.snapshotSequence &&
					nextCursor.snapshotTransactionIndex <= this._reconciledHistoryCursor.snapshotTransactionIndex))
		) {
			throw new HydraProtocolError('Hydra reconciliation cursor did not advance monotonically');
		}
		this._reconciledHistoryCursor = nextCursor;
		this._unreconciledConfirmedTransactions.delete(txHash);
		if (this._currentSnapshotProducerTxIds.has(txHash)) this._cursorPrefixProducerTxIds.add(txHash);
		this.trim();
	}

	/**
	 * The producer transactions the current signed snapshot pins, resolved
	 * against what an earlier frame in this pass already claimed — a replay
	 * that equivocates on the same snapshot's output references is rejected.
	 */
	resolveProtectedSnapshotProducerTxIds(snapshot: VerifiedHydraSnapshot): Set<string> {
		const frameProducerTxIds = new Set(
			[...snapshot.outputs.keys()].map((reference) => reference.slice(0, reference.indexOf('#')).toLowerCase()),
		);
		const retainedSnapshotNumber = this._currentSnapshotProducerSnapshotNumber;
		if (retainedSnapshotNumber == null || snapshot.number > retainedSnapshotNumber) return frameProducerTxIds;
		if (snapshot.number < retainedSnapshotNumber) return this._currentSnapshotProducerTxIds;
		if (!setsEqual(frameProducerTxIds, this._currentSnapshotProducerTxIds)) {
			throw new HydraProtocolError('Hydra history equivocated on output references for one signed snapshot');
		}
		return this._currentSnapshotProducerTxIds;
	}

	adoptSnapshotProducerTxIds(snapshot: VerifiedHydraSnapshot, protectedProducerTxIds: Set<string>): void {
		if (
			this._currentSnapshotProducerSnapshotNumber != null &&
			snapshot.number < this._currentSnapshotProducerSnapshotNumber
		) {
			return;
		}
		this._currentSnapshotProducerSnapshotNumber = snapshot.number;
		this._currentSnapshotProducerTxIds = new Set(protectedProducerTxIds);
		for (const txId of this._cursorPrefixProducerTxIds) {
			if (this._currentSnapshotProducerTxIds.has(txId)) continue;
			if (!this._unreconciledConfirmedTransactions.has(txId)) this._confirmedTransactions.delete(txId);
			this._cursorPrefixProducerTxIds.delete(txId);
		}
		this.trim();
	}

	/**
	 * Record one snapshot's confirmed transactions. Validates the entire signed
	 * transition, including the durable prefix — the cursor controls queuing
	 * only; it must never turn old malformed CBOR into an unchecked gap.
	 *
	 * Returns `truncated: true` when a budget could not hold the page; the
	 * caller owns what truncation means for the replay pass.
	 */
	record(
		parsedMessage: SnapshotConfirmedMessage,
		options: {
			/** Emit confirmations to consumers (a complete pass); false while replaying. */
			emitEvent: boolean;
			/** Trim the reconciled overflow as we go (only once the pass is complete). */
			replayComplete: boolean;
			protectedProducerTxIds: ReadonlySet<string>;
			onConfirmed: (txId: string, transaction: HydraConfirmedTransaction) => void;
		},
	): { truncated: boolean } {
		const { emitEvent, replayComplete, protectedProducerTxIds, onConfirmed } = options;
		const parsedTimestampMs = parsedMessage.timestamp ? Date.parse(parsedMessage.timestamp) : Number.NaN;
		const confirmedAtMs = Number.isNaN(parsedTimestampMs) ? null : parsedTimestampMs;
		const validatedTransactions = parsedMessage.snapshot.confirmed.map((tx, snapshotTransactionIndex) => {
			const parsedTxId = canonicalHydraTransactionIdSchema.safeParse(tx.txId);
			if (!parsedTxId.success) {
				throw new HydraProtocolError('SnapshotConfirmed contained a non-canonical transaction id');
			}
			let computedTxId: string;
			try {
				computedTxId = String(resolveTxHash(tx.cborHex)).toLowerCase();
			} catch (error) {
				throw new HydraProtocolError('SnapshotConfirmed contained invalid transaction CBOR', { cause: error });
			}
			if (computedTxId !== parsedTxId.data) {
				throw new HydraProtocolError('SnapshotConfirmed transaction id does not match its CBOR body');
			}
			const existing =
				this._confirmedTransactions.get(computedTxId) ?? this._unreconciledConfirmedTransactions.get(computedTxId);
			if (existing && existing.cborHex.toLowerCase() !== tx.cborHex.toLowerCase()) {
				throw new HydraProtocolError('SnapshotConfirmed equivocated on the CBOR for one transaction id');
			}
			if (
				existing &&
				(existing.snapshotSequence !== parsedMessage.seq ||
					existing.snapshotTransactionIndex !== snapshotTransactionIndex)
			) {
				throw new HydraProtocolError('SnapshotConfirmed replayed one transaction at a different history position');
			}
			const isAfterCursor =
				this._reconciledHistoryCursor == null ||
				parsedMessage.seq > this._reconciledHistoryCursor.snapshotSequence ||
				(parsedMessage.seq === this._reconciledHistoryCursor.snapshotSequence &&
					snapshotTransactionIndex > this._reconciledHistoryCursor.snapshotTransactionIndex);
			return { tx: { ...tx, txId: computedTxId }, snapshotTransactionIndex, existing, isAfterCursor };
		});
		if (new Set(validatedTransactions.map(({ tx }) => tx.txId)).size !== validatedTransactions.length) {
			throw new HydraProtocolError('SnapshotConfirmed contained duplicate transaction identifiers');
		}

		for (const { tx, snapshotTransactionIndex, existing, isAfterCursor } of validatedTransactions) {
			const isCurrentSnapshotProducer = protectedProducerTxIds.has(tx.txId);
			const shouldRetain = isAfterCursor || isCurrentSnapshotProducer;
			if (!shouldRetain) continue;
			if (existing) {
				if (!isAfterCursor && isCurrentSnapshotProducer) this._cursorPrefixProducerTxIds.add(tx.txId);
				if (isAfterCursor && !this._unreconciledConfirmedTransactions.has(tx.txId)) {
					this._unreconciledConfirmedTransactions.set(tx.txId, existing);
					this._txCircularBuffer.add(tx.txId);
					if (emitEvent) onConfirmed(tx.txId, existing);
				}
				continue;
			}
			const transactionCborBytes = tx.cborHex.length / 2;
			if (transactionCborBytes > this._maxRetainedTransactionCborBytes) {
				throw new HydraProtocolError('Hydra confirmation transaction exceeded the entire retained-CBOR byte budget');
			}
			if (isAfterCursor && this._unreconciledConfirmedTransactions.size >= this._maxUnreconciledTransactions) {
				return { truncated: true };
			}
			this.evictReconciledForCborBudget(transactionCborBytes, protectedProducerTxIds);
			if (this.getRetainedTransactionCborBytes() + transactionCborBytes > this._maxRetainedTransactionCborBytes) {
				if (isCurrentSnapshotProducer) {
					throw new HydraProtocolError(
						'Current Hydra snapshot producer evidence exceeded the retained-CBOR byte budget',
					);
				}
				return { truncated: true };
			}
			const confirmedTransaction: HydraConfirmedTransaction = {
				...tx,
				metadataSource: 'ConfiguredLocalHydraNode',
				// Only the official top-level timestamp proves confirmation time.
				// Missing/invalid time stays null and makes initial-lock sync retryable.
				confirmedAtMs,
				snapshotSequence: parsedMessage.seq,
				snapshotTransactionIndex,
			};
			this._confirmedTransactions.set(tx.txId, confirmedTransaction);
			if (isAfterCursor) {
				this._txCircularBuffer.add(tx.txId);
				this._unreconciledConfirmedTransactions.set(tx.txId, confirmedTransaction);
			} else this._cursorPrefixProducerTxIds.add(tx.txId);
			if (replayComplete) this.trim();
			if (isAfterCursor && emitEvent) onConfirmed(tx.txId, confirmedTransaction);
		}
		return { truncated: false };
	}

	/** Trim the reconciled overflow once a replay pass is known complete. */
	trim(): void {
		const excess = this._confirmedTransactions.size - 10_000;
		if (excess <= 0) return;
		const oldest = [...this._confirmedTransactions.values()]
			.filter(
				({ txId }) =>
					!this._unreconciledConfirmedTransactions.has(txId) && !this._currentSnapshotProducerTxIds.has(txId),
			)
			.sort(compareConfirmedTransactions)
			.slice(0, excess);
		for (const transaction of oldest) {
			this._confirmedTransactions.delete(transaction.txId);
			this._cursorPrefixProducerTxIds.delete(transaction.txId);
		}
	}

	private getRetainedTransactionCborBytes(): number {
		const retainedIds = new Set([
			...this._confirmedTransactions.keys(),
			...this._unreconciledConfirmedTransactions.keys(),
		]);
		let retainedBytes = 0;
		for (const txId of retainedIds) {
			const retained = this._confirmedTransactions.get(txId) ?? this._unreconciledConfirmedTransactions.get(txId);
			retainedBytes += (retained?.cborHex.length ?? 0) / 2;
		}
		return retainedBytes;
	}

	private evictReconciledForCborBudget(requiredBytes: number, protectedProducerTxIds: ReadonlySet<string>): void {
		let retainedBytes = this.getRetainedTransactionCborBytes();
		if (retainedBytes + requiredBytes <= this._maxRetainedTransactionCborBytes) return;
		const evictable = [...this._confirmedTransactions.values()]
			.filter(({ txId }) => !this._unreconciledConfirmedTransactions.has(txId) && !protectedProducerTxIds.has(txId))
			.sort(compareConfirmedTransactions);
		for (const transaction of evictable) {
			this._confirmedTransactions.delete(transaction.txId);
			this._cursorPrefixProducerTxIds.delete(transaction.txId);
			retainedBytes -= transaction.cborHex.length / 2;
			if (retainedBytes + requiredBytes <= this._maxRetainedTransactionCborBytes) return;
		}
	}

	clear(): void {
		this._confirmedTransactions.clear();
		this._unreconciledConfirmedTransactions.clear();
		this._txCircularBuffer.clear();
		this._currentSnapshotProducerTxIds.clear();
		this._currentSnapshotProducerSnapshotNumber = undefined;
		this._cursorPrefixProducerTxIds.clear();
	}
}
