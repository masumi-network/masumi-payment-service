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
