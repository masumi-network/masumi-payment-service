import { describe, expect, it } from '@jest/globals';
import { ConfirmedTransactionLedger } from './node-confirmed-ledger';
import { HydraConfirmedTransaction, HydraTransactionType } from './types';

function ledgerWith(transactions: HydraConfirmedTransaction[]): ConfirmedTransactionLedger {
	const ledger = new ConfirmedTransactionLedger({
		maxUnreconciledTransactions: 100,
		maxRetainedTransactionCborBytes: 1024 * 1024,
	});
	// Seed through the private maps the way record() would; the recording path
	// itself (CBOR/id validation, budgets, truncation) is exercised end-to-end
	// by node.spec.ts and recorded-history.spec.ts through HydraNode.
	const internal = ledger as unknown as {
		_confirmedTransactions: Map<string, HydraConfirmedTransaction>;
		_unreconciledConfirmedTransactions: Map<string, HydraConfirmedTransaction>;
	};
	for (const tx of transactions) {
		internal._confirmedTransactions.set(tx.txId, tx);
		internal._unreconciledConfirmedTransactions.set(tx.txId, tx);
	}
	return ledger;
}

function confirmed(txId: string, sequence: number, index: number): HydraConfirmedTransaction {
	return {
		type: HydraTransactionType.TxConwayEra,
		cborHex: 'aa'.repeat(8),
		description: '',
		txId,
		metadataSource: 'ConfiguredLocalHydraNode',
		confirmedAtMs: null,
		snapshotSequence: sequence,
		snapshotTransactionIndex: index,
	};
}

describe('ConfirmedTransactionLedger reconciliation cursor', () => {
	it('drains strictly in history order', () => {
		const ledger = ledgerWith([confirmed('bb', 1, 0), confirmed('aa', 1, 1), confirmed('cc', 2, 0)]);

		// 'aa' sorts after 'bb' by history position, not by id: position first.
		expect(() => ledger.markReconciled('aa')).toThrow(/must be reconciled in history order/);
		ledger.markReconciled('bb');
		ledger.markReconciled('aa');
		ledger.markReconciled('cc');
		expect(ledger.hasUnreconciled).toBe(false);
	});

	it('refuses a cursor that does not advance', () => {
		const ledger = new ConfirmedTransactionLedger({
			maxUnreconciledTransactions: 100,
			maxRetainedTransactionCborBytes: 1024 * 1024,
			// Durable cursor already past sequence 1.
			reconciledHistoryCursor: { snapshotSequence: 1, snapshotTransactionIndex: 5 },
		});
		const internal = ledger as unknown as {
			_unreconciledConfirmedTransactions: Map<string, HydraConfirmedTransaction>;
		};
		internal._unreconciledConfirmedTransactions.set('dd', confirmed('dd', 1, 2));

		expect(() => ledger.markReconciled('dd')).toThrow(/did not advance monotonically/);
	});

	it('reconciling an unknown hash with an empty queue is a no-op', () => {
		const ledger = ledgerWith([]);
		expect(() => ledger.markReconciled('ee')).not.toThrow();
	});
});

describe('ConfirmedTransactionLedger lookups', () => {
	it('serves lookups from both retained and unreconciled evidence, and clears fully', () => {
		const ledger = ledgerWith([confirmed('aa', 1, 0)]);
		expect(ledger.getConfirmedTransaction('aa')?.txId).toBe('aa');
		expect(ledger.getUnreconciledSorted().map((tx) => tx.txId)).toEqual(['aa']);

		ledger.clear();
		expect(ledger.getConfirmedTransaction('aa')).toBeNull();
		expect(ledger.hasUnreconciled).toBe(false);
		expect(ledger.getAllConfirmedSorted()).toEqual([]);
	});
});

// An incremental total has one failure mode a scan does not: drifting from the
// maps it describes. Every path that adds or removes a retained transaction is
// walked here and the counter is checked against the slow computation, because
// a counter that reads low silently disables the CBOR budget and one that reads
// high refuses evidence the head needs.
describe('ConfirmedTransactionLedger retained-byte accounting', () => {
	function recordingLedger(): {
		ledger: ConfirmedTransactionLedger;
		retain: (tx: HydraConfirmedTransaction) => void;
		release: (txId: string) => void;
	} {
		const ledger = new ConfirmedTransactionLedger({
			maxUnreconciledTransactions: 100,
			maxRetainedTransactionCborBytes: 1024 * 1024,
		});
		const internal = ledger as unknown as {
			retainConfirmed: (tx: HydraConfirmedTransaction) => void;
			releaseConfirmed: (txId: string) => void;
		};
		return {
			ledger,
			retain: (tx) => internal.retainConfirmed(tx),
			release: (txId) => internal.releaseConfirmed(txId),
		};
	}

	it('matches the slow computation as transactions are retained and released', () => {
		const { ledger, retain, release } = recordingLedger();

		retain(confirmed('aa', 1, 0));
		retain(confirmed('bb', 1, 1));
		retain(confirmed('cc', 2, 0));
		expect(ledger.retainedTransactionCborBytes).toBe(ledger.computeRetainedTransactionCborBytes());
		expect(ledger.retainedTransactionCborBytes).toBe(24);

		release('bb');
		expect(ledger.retainedTransactionCborBytes).toBe(ledger.computeRetainedTransactionCborBytes());
		expect(ledger.retainedTransactionCborBytes).toBe(16);
	});

	it('does not double-count a transaction recorded twice', () => {
		const { ledger, retain } = recordingLedger();

		retain(confirmed('aa', 1, 0));
		retain(confirmed('aa', 1, 0));

		expect(ledger.retainedTransactionCborBytes).toBe(ledger.computeRetainedTransactionCborBytes());
		expect(ledger.retainedTransactionCborBytes).toBe(8);
	});

	it('does not subtract for a release of something it never held', () => {
		const { ledger, retain, release } = recordingLedger();

		retain(confirmed('aa', 1, 0));
		release('zz');
		release('zz');

		expect(ledger.retainedTransactionCborBytes).toBe(ledger.computeRetainedTransactionCborBytes());
		expect(ledger.retainedTransactionCborBytes).toBe(8);
	});

	it('returns to zero when the ledger is cleared', () => {
		const { ledger, retain } = recordingLedger();

		retain(confirmed('aa', 1, 0));
		ledger.clear();

		expect(ledger.retainedTransactionCborBytes).toBe(0);
		expect(ledger.computeRetainedTransactionCborBytes()).toBe(0);
	});
});
