import { describe, expect, it, jest } from '@jest/globals';

const mockWarn = jest.fn();

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: jest.fn(), info: jest.fn(), warn: mockWarn, error: jest.fn() },
}));

const {
	extractClosedHeadFacts,
	extractCommitNotSettled,
	extractDecommitInFlight,
	extractHeadOutputTxId,
	extractPendingDecommitRefs,
} = await import('./head-output-tx');

const HEAD_ID = 'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed00';
const CLOSE_TX = 'f96e9b1375c44ac6865c19682df5043911f15682db436ba27948421d75ccc2f5';
const OTHER_TX = '8cea6c121fe2cbb5' + 'a'.repeat(48);

function headState(spendableUTxO: Record<string, unknown>): unknown {
	// The real shape hydra-node emits (2.3.0 and 2.4.1): chainState nests under
	// `contents`, not at the top level of the head state.
	return { tag: 'Closed', contents: { chainState: { spendableUTxO, recordedAt: null } } };
}

/** An output carrying the head's state token, as hydra reports it. */
function headOutput(): Record<string, unknown> {
	return {
		address: 'addr_test1wq2b91a7e6',
		value: { lovelace: 232498020, [HEAD_ID]: { HydraHeadV1: 1 } },
	};
}

/**
 * The real shape hydra-node's `GET /head` emits while Open: the confirmed
 * snapshot's `utxoToDecommit` nests under
 * `contents.coordinatedHeadState.confirmedSnapshot.snapshot`, alongside the
 * sibling `decommitTx` and version fields that say whether that snapshot's
 * decommit is still unresolved.
 */
function decommitHeadState(
	utxoToDecommit: unknown,
	options: { decommitTx?: unknown; version?: unknown; snapshotVersion?: unknown } = {},
): unknown {
	const { decommitTx = {}, version = 1, snapshotVersion = 1 } = options;
	return {
		tag: 'Open',
		contents: {
			coordinatedHeadState: {
				decommitTx,
				version,
				confirmedSnapshot: { snapshot: { version: snapshotVersion, utxoToDecommit } },
			},
		},
	};
}

describe('extractHeadOutputTxId', () => {
	it('returns the transaction that produced the head output', () => {
		expect(extractHeadOutputTxId(headState({ [`${CLOSE_TX}#0`]: headOutput() }), HEAD_ID)).toBe(CLOSE_TX);
	});

	it('picks the head output out of a set containing other outputs', () => {
		const state = headState({
			[`${OTHER_TX}#3`]: { address: 'addr_test1vz', value: { lovelace: 4835820 } },
			[`${CLOSE_TX}#0`]: headOutput(),
			[`${OTHER_TX}#7`]: { address: 'addr_test1vz', value: { lovelace: 99138000 } },
		});

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBe(CLOSE_TX);
	});

	it('ignores an output at the same address that does not hold the head token', () => {
		// Anyone can pay to the head script address. Only the one-shot state token
		// makes an output the head's, which is what stops a spoofed close hash.
		const state = headState({
			[`${OTHER_TX}#0`]: { address: 'addr_test1wq2b91a7e6', value: { lovelace: 5000000 } },
		});

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBeUndefined();
	});

	it("ignores an output holding a different head's token", () => {
		const foreignHead = 'a'.repeat(56);
		const state = headState({
			[`${OTHER_TX}#0`]: { address: 'addr_test1w', value: { lovelace: 5000000, [foreignHead]: { HydraHeadV1: 1 } } },
		});

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBeUndefined();
	});

	it('does not mistake a bare quantity under a policy-shaped key for a token bucket', () => {
		const state = headState({
			[`${CLOSE_TX}#0`]: { address: 'addr_test1w', value: { lovelace: 1, [HEAD_ID]: 1 } },
		});

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBeUndefined();
	});

	it('matches the head identifier case-insensitively and returns lowercase', () => {
		const upper = `${CLOSE_TX.toUpperCase()}#0`;
		const state = headState({ [upper]: headOutput() });

		expect(extractHeadOutputTxId(state, HEAD_ID.toUpperCase())).toBe(CLOSE_TX);
	});

	it('matches when the node emits the policy id in a different case than ours', () => {
		// Our side is normalised by canonicalHydraHeadIdSchema; the key in this map
		// is the node's. An exact-key lookup would report the head output absent
		// and say nothing about why.
		const state = headState({
			[`${CLOSE_TX}#0`]: {
				address: 'addr_test1wq2b91a7e6',
				value: { lovelace: 232498020, [HEAD_ID.toUpperCase()]: { HydraHeadV1: 1 } },
			},
		});

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBe(CLOSE_TX);
	});

	it('skips keys that are not output references', () => {
		const state = headState({ 'not-a-reference': headOutput(), [`${CLOSE_TX}#1`]: headOutput() });

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBe(CLOSE_TX);
	});

	it('returns undefined rather than throwing on anything malformed', () => {
		expect(extractHeadOutputTxId(null, HEAD_ID)).toBeUndefined();
		expect(extractHeadOutputTxId('closed', HEAD_ID)).toBeUndefined();
		expect(extractHeadOutputTxId({}, HEAD_ID)).toBeUndefined();
		expect(extractHeadOutputTxId({ chainState: {} }, HEAD_ID)).toBeUndefined();
		expect(extractHeadOutputTxId(headState({}), HEAD_ID)).toBeUndefined();
		expect(extractHeadOutputTxId(headState({ [`${CLOSE_TX}#0`]: null }), HEAD_ID)).toBeUndefined();
	});

	it('refuses a head identifier that is not a currency symbol', () => {
		const state = headState({ [`${CLOSE_TX}#0`]: headOutput() });

		expect(extractHeadOutputTxId(state, 'nonsense')).toBeUndefined();
		expect(extractHeadOutputTxId(state, '')).toBeUndefined();
	});

	it('handles an Idle head state, which carries no chain state at all', () => {
		expect(extractHeadOutputTxId({ tag: 'Idle' }, HEAD_ID)).toBeUndefined();
		expect(extractHeadOutputTxId({ tag: 'Idle', contents: {} }, HEAD_ID)).toBeUndefined();
	});

	it('still accepts the flat shape, with chainState at the top level rather than under contents', () => {
		const state = {
			tag: 'Closed',
			chainState: { spendableUTxO: { [`${CLOSE_TX}#0`]: headOutput() }, recordedAt: null },
		};

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBe(CLOSE_TX);
	});

	/**
	 * hydra-node identifies the head output by currency symbol AND by it being
	 * the head validator's script output. Only the symbol is visible here, and
	 * participation tokens share it — so two matches means we cannot tell which
	 * is the state output, and naming the wrong transaction is worse than none.
	 */
	it('refuses to guess when more than one output carries the head token', () => {
		const state = headState({
			[`${CLOSE_TX}#0`]: headOutput(),
			[`${OTHER_TX}#1`]: { address: 'addr_test1vz', value: { lovelace: 2000000, [HEAD_ID]: { HydraHeadV1: 1 } } },
		});

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBeUndefined();
	});

	it('gives up loudly on an implausibly large state, rather than silently', () => {
		// Reaching the cap and finding nothing return the same value, so the log is
		// the only thing that tells them apart. An unlogged bail would read as "this
		// head has no state output", which is a very different problem.
		mockWarn.mockClear();
		const huge: Record<string, unknown> = {};
		for (let index = 0; index <= 5_000; index += 1) {
			huge[`${OTHER_TX.slice(0, 60)}${index.toString(16).padStart(4, '0')}#0`] = {
				address: 'addr_test1vz',
				value: { lovelace: 1 },
			};
		}

		expect(extractHeadOutputTxId(headState(huge), HEAD_ID)).toBeUndefined();
		expect(mockWarn).toHaveBeenCalledTimes(1);
	});

	it('stays quiet when it simply does not find the head output', () => {
		mockWarn.mockClear();

		expect(extractHeadOutputTxId(headState({}), HEAD_ID)).toBeUndefined();
		expect(mockWarn).not.toHaveBeenCalled();
	});

	it('skips an output index too large to be real', () => {
		const state = headState({ [`${CLOSE_TX}#4294967296`]: headOutput() });

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBeUndefined();
	});

	it('still resolves when one transaction produced several head-token outputs', () => {
		// Same producing transaction at two indices is not ambiguous: the answer
		// is the same transaction either way.
		const state = headState({
			[`${CLOSE_TX}#0`]: headOutput(),
			[`${CLOSE_TX}#1`]: headOutput(),
		});

		expect(extractHeadOutputTxId(state, HEAD_ID)).toBe(CLOSE_TX);
	});
});

describe('extractPendingDecommitRefs', () => {
	it('returns the pending decommit output references, lower-cased', () => {
		const state = decommitHeadState({ [`${CLOSE_TX.toUpperCase()}#0`]: headOutput() });

		expect(extractPendingDecommitRefs(state)).toEqual([`${CLOSE_TX}#0`]);
	});

	it('returns no pending refs when utxoToDecommit is null', () => {
		expect(extractPendingDecommitRefs(decommitHeadState(null))).toEqual([]);
	});

	it('returns no pending refs for an Idle head state, which carries no coordinatedHeadState at all', () => {
		expect(extractPendingDecommitRefs({ tag: 'Idle' })).toEqual([]);
		expect(extractPendingDecommitRefs({ tag: 'Idle', contents: {} })).toEqual([]);
	});

	it('still accepts the flat shape, with coordinatedHeadState at the top level rather than under contents', () => {
		const state = {
			tag: 'Open',
			coordinatedHeadState: {
				// A held decommitTx, so this is testing the flat-vs-nested shape only —
				// not also, by omission, the "both signals unreadable" case covered below.
				decommitTx: {},
				confirmedSnapshot: { snapshot: { utxoToDecommit: { [`${CLOSE_TX}#0`]: headOutput() } } },
			},
		};

		expect(extractPendingDecommitRefs(state)).toEqual([`${CLOSE_TX}#0`]);
	});

	/**
	 * The bug this fixes: `utxoToDecommit` stays populated in the LAST
	 * confirmed snapshot until a NEW snapshot is produced, which only happens
	 * once another transaction arrives — so it lags a finalized decommit
	 * indefinitely. `decommitTx: null` plus the chain having moved past the
	 * snapshot version (`coordinatedHeadState.version` > `snapshot.version`) is
	 * the live shape once `DecommitFinalized` fires (observed 8 vs 7).
	 */
	it('returns no pending refs once decommitTx is cleared and the chain has moved past the snapshot version', () => {
		const state = decommitHeadState(
			{ [`${CLOSE_TX}#0`]: headOutput() },
			{ decommitTx: null, version: 8, snapshotVersion: 7 },
		);

		expect(extractPendingDecommitRefs(state)).toEqual([]);
	});

	it('still returns pending refs when decommitTx is null but the chain has not moved past the snapshot version', () => {
		const state = decommitHeadState(
			{ [`${CLOSE_TX}#0`]: headOutput() },
			{ decommitTx: null, version: 7, snapshotVersion: 7 },
		);

		expect(extractPendingDecommitRefs(state)).toEqual([`${CLOSE_TX}#0`]);
	});

	it('still returns pending refs while the node holds a decommitTx, even past the snapshot version', () => {
		const state = decommitHeadState(
			{ [`${CLOSE_TX}#0`]: headOutput() },
			{ decommitTx: { cbor: 'deadbeef' }, version: 8, snapshotVersion: 7 },
		);

		expect(extractPendingDecommitRefs(state)).toEqual([`${CLOSE_TX}#0`]);
	});

	/**
	 * The deadlock this guards against: with no decommitTx held AND no readable
	 * version pair, the old formula defaulted `chainNotPastSnapshot` to `true`
	 * (fail-closed), so `!decommitTxHeld && !chainNotPastSnapshot` was always
	 * false and the withdrawal stayed refused forever. Unlike a transport error,
	 * an unrecognised shape does not pass on retry, so both signals unreadable
	 * resolve to no pending refs, logged.
	 */
	it('returns no pending refs, and logs, when neither decommitTx nor the version pair can be read', () => {
		mockWarn.mockClear();
		const state = {
			tag: 'Open',
			contents: {
				coordinatedHeadState: {
					// decommitTx omitted entirely: cannot be read as an object.
					confirmedSnapshot: { snapshot: { utxoToDecommit: { [`${CLOSE_TX}#0`]: headOutput() } } },
					// version and snapshot.version both omitted: not numbers.
				},
			},
		};

		expect(extractPendingDecommitRefs(state)).toEqual([]);
		expect(mockWarn).toHaveBeenCalledTimes(1);
	});
});

/**
 * Feeds the decision to expire an old withdrawal, so it must never read
 * "nothing in flight" off a state it could not read.
 */
describe('extractDecommitInFlight', () => {
	it('reports a held decommit before any snapshot names its outputs', () => {
		expect(extractDecommitInFlight(decommitHeadState(null, { decommitTx: { txId: OTHER_TX } }))).toBe(true);
	});

	it('reports a decommit the confirmed snapshot still waits on', () => {
		const state = decommitHeadState({ [`${OTHER_TX}#0`]: {} }, { decommitTx: null, version: 1, snapshotVersion: 1 });
		expect(extractDecommitInFlight(state)).toBe(true);
	});

	it('reports nothing in flight once the node holds none and the snapshot is settled', () => {
		expect(extractDecommitInFlight(decommitHeadState({}, { decommitTx: null }))).toBe(false);
	});

	// A node that left the field out has not said it holds nothing.
	it('cannot tell when the node does not report decommitTx at all', () => {
		const state = { tag: 'Open', contents: { coordinatedHeadState: { version: 2 } } };
		expect(extractDecommitInFlight(state)).toBeUndefined();
	});

	it('cannot tell from a state without a coordinated head state', () => {
		expect(extractDecommitInFlight({ tag: 'Idle' })).toBeUndefined();
		expect(extractDecommitInFlight('not json')).toBeUndefined();
	});
});

/**
 * hydra-node 2.4.1 `waitForDeposit`: a commit is unsettled while the head's
 * version still equals the confirmed snapshot's version.
 */
describe('extractCommitNotSettled', () => {
	const COMMIT = { [`${OTHER_TX}#0`]: {} };
	const commitHeadState = (utxoToCommit: unknown, version: unknown = 3, snapshotVersion: unknown = 3) => ({
		tag: 'Open',
		contents: {
			coordinatedHeadState: { version, confirmedSnapshot: { snapshot: { version: snapshotVersion, utxoToCommit } } },
		},
	});

	it('reports a commit the chain has not settled, even an empty one, as hydra checks only that it is set', () => {
		expect(extractCommitNotSettled(commitHeadState(COMMIT))).toBe(true);
		expect(extractCommitNotSettled(commitHeadState({}))).toBe(true);
	});

	it.each([
		['the chain has settled it', commitHeadState(COMMIT, 4, 3)],
		['the snapshot holds no commit', commitHeadState(null)],
		[
			'the head is still on its initial snapshot',
			{
				tag: 'Open',
				contents: { coordinatedHeadState: { version: 0, confirmedSnapshot: { tag: 'InitialSnapshot' } } },
			},
		],
	])('reports nothing unsettled when %s', (_label, state) => {
		expect(extractCommitNotSettled(state)).toBe(false);
	});

	it.each([
		['the versions are not numbers', commitHeadState(COMMIT, '3', 3)],
		['the head state has no confirmed snapshot', { tag: 'Open' }],
		['the node reports Closed while the row remains Open', { ...commitHeadState(null), tag: 'Closed' }],
	])('reports unknown settlement when %s', (_label, state) => {
		expect(extractCommitNotSettled(state)).toBeNull();
	});
});

/**
 * A head closed while the service was off is first seen through Greetings, which
 * carry no deadline. hydra-node 2.4.1 keeps it in `ClosedState` and, once partial
 * fanout starts, in `PartialFanoutState`.
 */
describe('extractClosedHeadFacts', () => {
	const DEADLINE = '2026-10-22T12:00:00Z';
	const confirmed = (number: unknown) => ({
		tag: 'ConfirmedSnapshot',
		snapshot: { headId: HEAD_ID, version: 0, number },
		signatures: {},
	});
	const closedState = (confirmedSnapshot: unknown, contents: Record<string, unknown> = {}) => ({
		tag: 'Closed',
		contents: {
			headId: HEAD_ID,
			contestationDeadline: DEADLINE,
			confirmedSnapshot,
			readyToFanoutSent: false,
			...contents,
		},
	});

	it('reads the deadline of a closed head and no snapshot number', () => {
		// `confirmedSnapshot` is the node's own snapshot, not the one the close put on chain.
		expect(extractClosedHeadFacts(closedState(confirmed(7)), HEAD_ID)).toEqual({ contestationDeadline: DEADLINE });
	});

	it.each([
		['missing', undefined],
		['of a kind it does not know', { tag: 'SomethingElse' }],
	])('reads the deadline when the confirmed snapshot is %s', (_label, confirmedSnapshot) => {
		expect(extractClosedHeadFacts(closedState(confirmedSnapshot), HEAD_ID)).toEqual({ contestationDeadline: DEADLINE });
	});

	it('reads it once the head fans out in steps', () => {
		const state = { tag: 'FanoutProgress', contents: { ...closedState(confirmed(12)).contents, remainingOutputs: {} } };

		expect(extractClosedHeadFacts(state, HEAD_ID)).toEqual({ contestationDeadline: DEADLINE });
	});

	it('accepts a state that is not nested under contents', () => {
		const flat = { tag: 'Closed', ...closedState(confirmed(3)).contents };

		expect(extractClosedHeadFacts(flat, HEAD_ID)).toEqual({ contestationDeadline: DEADLINE });
	});

	it('does not need the state to carry a head id', () => {
		const { headId: _headId, ...withoutHeadId } = closedState(confirmed(4)).contents;

		expect(extractClosedHeadFacts({ tag: 'Closed', contents: withoutHeadId }, HEAD_ID)).toEqual({
			contestationDeadline: DEADLINE,
		});
	});

	it('matches the head id whatever its case', () => {
		expect(extractClosedHeadFacts(closedState(confirmed(1), { headId: HEAD_ID.toUpperCase() }), HEAD_ID)).toEqual({
			contestationDeadline: DEADLINE,
		});
	});

	// Unknown must never become a value: a missing fact stays missing, so a later read can still fill it.
	it.each([
		['the node reports no head', { tag: 'Idle', contents: { chainState: {} } }],
		['it is not an object', 'Closed'],
		['it is null', null],
		['the deadline is missing', closedState(confirmed(7), { contestationDeadline: undefined })],
		['the deadline is not a string', closedState(confirmed(7), { contestationDeadline: 1_761_134_400 })],
		['the state belongs to another head', closedState(confirmed(7), { headId: 'f'.repeat(56) })],
	])('says nothing when %s', (_label, state) => {
		expect(extractClosedHeadFacts(state, HEAD_ID)).toBeUndefined();
	});

	it('says nothing without a well-formed head id to check against', () => {
		expect(extractClosedHeadFacts(closedState(confirmed(7)), 'not-a-head-id')).toBeUndefined();
	});
});
