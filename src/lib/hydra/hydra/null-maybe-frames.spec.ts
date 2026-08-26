/**
 * A Haskell `Maybe` serialized as `null` must not wedge a head.
 *
 * Three UTxO fields were modelled `.optional()` but not `.nullable()`, while the
 * guards that decide whether to parse them tested PRESENCE — and `'x' in obj` is
 * true for `{ x: null }`. A frame carrying the legacy field as an explicit null
 * therefore passed the guard and threw inside the parse.
 *
 * On the replay path that is permanent: history replays from the beginning on
 * every reconnect, so the same frame is rejected forever, the head never gets a
 * verified session, and every L2 escrow operation fails closed. On the live path
 * it is quieter and worse to diagnose — the Final transition is simply never
 * emitted, so the head is never recorded Final and its fanout map never captured.
 */

import { describe, expect, it } from '@jest/globals';
import {
	greetingsSnapshotMessageSchema,
	hasFinalizedUtxoField,
	headIsFinalizedMessageSchema,
	historyHeadIsOpenMessageSchema,
	finalizedUtxoOf,
} from './schemas';

const HEAD_ID = 'a'.repeat(56);
const REFERENCE = `${'b'.repeat(64)}#0`;
const OUTPUT = {
	address: 'addr_test1abc',
	value: { lovelace: 1_000_000 },
	referenceScript: null,
	inlineDatum: null,
	inlineDatumRaw: null,
	datum: null,
};

describe('null-valued Maybe UTxO fields', () => {
	it('does not claim a finalized map when the only field present is null', () => {
		expect(hasFinalizedUtxoField({ tag: 'HeadIsFinalized', utxo: null })).toBe(false);
		expect(hasFinalizedUtxoField({ tag: 'HeadIsFinalized', finalizedUTxO: null, utxo: null })).toBe(false);
	});

	it('still claims one when a map is actually there', () => {
		expect(hasFinalizedUtxoField({ tag: 'HeadIsFinalized', finalizedUTxO: {} })).toBe(true);
		expect(hasFinalizedUtxoField({ tag: 'HeadIsFinalized', utxo: {} })).toBe(true);
	});

	// The legacy field survived the rename, which is exactly the kind a node
	// emits as an explicit null once it stops populating it.
	it('parses HeadIsFinalized carrying the new map and a null legacy field', () => {
		const parsed = headIsFinalizedMessageSchema.parse({
			tag: 'HeadIsFinalized',
			headId: HEAD_ID,
			finalizedUTxO: { [REFERENCE]: OUTPUT },
			utxo: null,
		});

		expect(Object.keys(finalizedUtxoOf(parsed))).toEqual([REFERENCE]);
	});

	it('still refuses HeadIsFinalized with no map under either name', () => {
		expect(
			headIsFinalizedMessageSchema.safeParse({ tag: 'HeadIsFinalized', headId: HEAD_ID, utxo: null }).success,
		).toBe(false);
	});

	it('parses HeadIsOpen and Greetings with a null utxo rather than throwing', () => {
		expect(historyHeadIsOpenMessageSchema.parse({ tag: 'HeadIsOpen', headId: HEAD_ID, utxo: null }).utxo).toBeNull();
		expect(
			greetingsSnapshotMessageSchema.parse({ tag: 'Greetings', hydraHeadId: HEAD_ID, snapshotUtxo: null }).snapshotUtxo,
		).toBeNull();
	});
});
