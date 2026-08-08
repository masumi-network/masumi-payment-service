import { describe, expect, it } from '@jest/globals';

import { extractHeadOutputTxId } from './head-output-tx';

const HEAD_ID = 'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed00';
const CLOSE_TX = 'f96e9b1375c44ac6865c19682df5043911f15682db436ba27948421d75ccc2f5';
const OTHER_TX = '8cea6c121fe2cbb5' + 'a'.repeat(48);

function headState(spendableUTxO: Record<string, unknown>): unknown {
	return { tag: 'Closed', chainState: { spendableUTxO, recordedAt: null } };
}

/** An output carrying the head's state token, as hydra reports it. */
function headOutput(): Record<string, unknown> {
	return {
		address: 'addr_test1wq2b91a7e6',
		value: { lovelace: 232498020, [HEAD_ID]: { HydraHeadV1: 1 } },
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
