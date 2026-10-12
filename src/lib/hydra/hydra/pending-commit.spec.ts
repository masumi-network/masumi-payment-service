import { describe, expect, it } from '@jest/globals';
import { extractPendingCommitRefs } from './pending-commit';

const WALLET_REF = `${'7c'.repeat(32)}#1`;

// Shapes captured from hydra-node 2.4.1 `GET /head` on preprod.
function headState(coordinated: Record<string, unknown>) {
	return {
		tag: 'Open',
		contents: {
			coordinatedHeadState: {
				confirmedSnapshot: {
					tag: 'ConfirmedSnapshot',
					snapshot: { version: 4, utxo: {}, utxoToCommit: { [WALLET_REF]: {} }, utxoToDecommit: null },
				},
				...coordinated,
			},
		},
	};
}

describe('extractPendingCommitRefs', () => {
	it('reports the approved deposit until the increment is observed', () => {
		expect(extractPendingCommitRefs(headState({ version: 4, currentDepositTxId: 'ab'.repeat(32) }))).toEqual([
			WALLET_REF,
		]);
	});

	it('clears it once the head version moves past the snapshot (CommitFinalized)', () => {
		expect(extractPendingCommitRefs(headState({ version: 5, currentDepositTxId: null }))).toEqual([]);
	});

	it('ignores a finalized set left in the snapshot while the next deposit waits for approval', () => {
		expect(extractPendingCommitRefs(headState({ version: 5, currentDepositTxId: 'cd'.repeat(32) }))).toEqual([]);
	});

	it('keeps it pending from the version pair alone once the deposit id is cleared', () => {
		expect(extractPendingCommitRefs(headState({ version: 4, currentDepositTxId: null }))).toEqual([WALLET_REF]);
	});

	it('lower-cases the refs so they match refs built from mesh UTxOs', () => {
		const upper = headState({ version: 4 });
		const snapshot = upper.contents.coordinatedHeadState.confirmedSnapshot.snapshot;
		snapshot.utxoToCommit = { [WALLET_REF.toUpperCase()]: {} };
		expect(extractPendingCommitRefs(upper)).toEqual([WALLET_REF]);
	});

	it('keeps it pending while a deposit is in progress even if the versions are unreadable', () => {
		expect(extractPendingCommitRefs(headState({ currentDepositTxId: 'ab'.repeat(32) }))).toEqual([WALLET_REF]);
	});

	it('treats an unreadable state with no deposit in progress as finalized', () => {
		expect(extractPendingCommitRefs(headState({}))).toEqual([]);
		expect(extractPendingCommitRefs(null)).toEqual([]);
	});
});
