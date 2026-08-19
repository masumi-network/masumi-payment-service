/**
 * A quantity the summary cannot add up must not wedge the head.
 *
 * `hydraAssetQuantitySchema` admits numbers, strings and bigints on purpose —
 * `json-bigint` returns different types by magnitude, and refusing one would
 * make `DecommitFinalized` unparseable, which on the replay path is permanent:
 * history replays from the beginning on every reconnect, so the frame is
 * rejected forever, the head never gets a verified session, and every L2 escrow
 * operation on it fails closed. A bare `BigInt()` on that deliberately wide
 * value throws inside the replay's try and produces the same outage the width
 * was there to prevent.
 */

import { describe, expect, it } from '@jest/globals';
import { summarizeDistributedUtxo } from './node-frames';

const REFERENCE = `${'ab'.repeat(32)}#0`;
const POLICY = 'cd'.repeat(28);

describe('summarizeDistributedUtxo', () => {
	it('adds up the shapes json-bigint actually produces', () => {
		const summary = summarizeDistributedUtxo({
			[REFERENCE]: { value: { lovelace: 1_000_000, [POLICY]: { '0014df10': '25' } } },
			[`${'cd'.repeat(32)}#1`]: { value: { lovelace: '2000000000000000' } },
		});

		expect(summary).toEqual({
			lovelace: 2_000_000_001_000_000n,
			assets: { [`${POLICY}0014df10`]: '25' },
		});
	});

	it('reports nothing rather than throwing on a quantity it cannot read', () => {
		expect(summarizeDistributedUtxo({ [REFERENCE]: { value: { lovelace: '1000000 lovelace' } } })).toBeUndefined();
		expect(summarizeDistributedUtxo({ [REFERENCE]: { value: { lovelace: 1.5 } } })).toBeUndefined();
		expect(summarizeDistributedUtxo({ [REFERENCE]: { value: { lovelace: '' } } })).toBeUndefined();
	});

	it('reports nothing on an unreadable native-asset quantity too', () => {
		expect(
			summarizeDistributedUtxo({ [REFERENCE]: { value: { [POLICY]: { '0014df10': 'not-a-number' } } } }),
		).toBeUndefined();
	});
});

// The value map is `z.record(string, quantity | record(string, quantity))` — it
// admits a nested map under ANY key, `lovelace` included, and its keys are
// node-supplied strings. Both were read as if they were neither.
describe('summarizeDistributedUtxo against the shapes the schema admits', () => {
	// The cast that used to stand on this branch asserted away the one shape
	// `toAssetQuantity` cannot read: it falls through to `value.trim()`, and an
	// object has no `.trim`. The TypeError lands inside the replay's try.
	it('reports nothing rather than throwing on a nested lovelace value', () => {
		expect(summarizeDistributedUtxo({ [REFERENCE]: { value: { lovelace: { '': 1 } } } })).toBeUndefined();
	});

	// `assets['constructor']` on an object literal is a function, and `BigInt()`
	// of one throws. The unit is `policyId + assetName`, both node-supplied.
	it.each(['constructor', 'toString', 'valueOf', '__proto__'])(
		'sums an asset named after Object.prototype.%s without throwing',
		(inherited) => {
			const summary = summarizeDistributedUtxo({
				[REFERENCE]: { value: { '': { [inherited]: '7' } } },
			});

			expect(summary?.assets[inherited]).toBe('7');
		},
	);

	// A 4MB frame can carry ~10^5 keys, and the summary is persisted. The bound
	// belongs here rather than in the schema: a cap that rejects a frame is a cap
	// that wedges the head.
	it('drops the summary rather than persisting an unbounded asset map', () => {
		const value: Record<string, Record<string, string>> = {};
		for (let index = 0; index <= 1_001; index += 1) value[`${index}`.padStart(56, '0')] = { '00': '1' };

		expect(summarizeDistributedUtxo({ [REFERENCE]: { value } })).toBeUndefined();
	});
	// `settledLovelace` is a Postgres int8. A sum past its range makes the write
	// throw, and the withdrawal stays Approved and is retried forever — the same
	// permanence a rejected frame has, arrived at from the other side.
	it('drops the summary rather than reporting a total the column cannot hold', () => {
		const half = ((1n << 63n) - 1n).toString();

		expect(
			summarizeDistributedUtxo({
				[REFERENCE]: { value: { lovelace: half } },
				[`${'cd'.repeat(32)}#1`]: { value: { lovelace: half } },
			}),
		).toBeUndefined();
	});

	it('drops the summary rather than reporting a single out-of-range quantity', () => {
		expect(summarizeDistributedUtxo({ [REFERENCE]: { value: { lovelace: (1n << 64n).toString() } } })).toBeUndefined();
	});

	it('drops the summary rather than reporting a negative quantity', () => {
		expect(summarizeDistributedUtxo({ [REFERENCE]: { value: { lovelace: '-1' } } })).toBeUndefined();
		expect(summarizeDistributedUtxo({ [REFERENCE]: { value: { [POLICY]: { '0014df10': -5 } } } })).toBeUndefined();
	});

	it('drops the summary rather than reporting an out-of-range asset total', () => {
		const half = ((1n << 62n) + 1n).toString();

		expect(
			summarizeDistributedUtxo({
				[REFERENCE]: { value: { [POLICY]: { '0014df10': half } } },
				[`${'cd'.repeat(32)}#1`]: { value: { [POLICY]: { '0014df10': half } } },
			}),
		).toBeUndefined();
	});
});
