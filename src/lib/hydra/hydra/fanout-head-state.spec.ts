import { describe, expect, it } from '@jest/globals';

import { HydraFanoutHeadStateError, parseFanoutHeadState } from './fanout-head-state';

const OUTPUT = {
	address: 'addr_test1vz',
	value: { lovelace: 2_000_000 },
	referenceScript: null,
	inlineDatum: null,
	inlineDatumRaw: null,
	datum: null,
};
const HELD = `${'aa'.repeat(32)}#0`;
const COMMIT = `${'bb'.repeat(32)}#0`;
const DECOMMIT = `${'cc'.repeat(32)}#0`;

function closedHead(snapshotVersion: number, onChainVersion: number) {
	return {
		tag: 'Closed',
		contents: {
			version: onChainVersion,
			confirmedSnapshot: {
				tag: 'ConfirmedSnapshot',
				signatures: { multiSignature: [] },
				snapshot: {
					version: snapshotVersion,
					number: 7,
					utxo: { [HELD]: OUTPUT },
					utxoToCommit: { [COMMIT]: OUTPUT },
					utxoToDecommit: { [DECOMMIT]: OUTPUT },
				},
			},
		},
	};
}

describe('parseFanoutHeadState', () => {
	// The node fans out a pending decommit only when the snapshot is at the
	// on-chain version, and a pending commit only when it is not. Listing the
	// other one made the node refuse a selection this service offered.
	it('adds the pending decommit, not the commit, at the on-chain version', () => {
		const state = parseFanoutHeadState(closedHead(3, 3));
		expect(state?.mode).toBeNull();
		expect(Object.keys(state!.selectable).sort()).toEqual([HELD, DECOMMIT].sort());
	});

	it('adds the pending commit, not the decommit, past the on-chain version', () => {
		expect(Object.keys(parseFanoutHeadState(closedHead(4, 3))!.selectable).sort()).toEqual([HELD, COMMIT].sort());
	});

	it('holds nothing for a head closed on its initial snapshot', () => {
		const state = parseFanoutHeadState({
			tag: 'Closed',
			contents: { version: 0, confirmedSnapshot: { tag: 'InitialSnapshot', headId: 'ab'.repeat(14) } },
		});
		expect(state).toEqual({ mode: null, selectable: {} });
	});

	it('reads the remaining outputs and mode while fanning out', () => {
		const state = parseFanoutHeadState({
			tag: 'FanoutProgress',
			contents: { remainingOutputs: { [COMMIT]: OUTPUT }, mode: { tag: 'AutoDrain' } },
		});
		expect(state?.mode).toBe('AutoDrain');
		expect(Object.keys(state!.selectable)).toEqual([COMMIT]);
		expect(state!.selectable[COMMIT]!.value.lovelace).toBe(2_000_000n);
	});

	it('returns null for a head that is not closed', () => {
		expect(parseFanoutHeadState({ tag: 'Open', contents: {} })).toBeNull();
		expect(parseFanoutHeadState(null)).toBeNull();
	});

	it('refuses a closed head state it cannot read', () => {
		expect(() =>
			parseFanoutHeadState({ tag: 'FanoutProgress', contents: { remainingOutputs: {}, mode: { tag: 'Paused' } } }),
		).toThrow(HydraFanoutHeadStateError);
	});
});
