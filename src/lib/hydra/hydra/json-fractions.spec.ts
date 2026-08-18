/**
 * A long fractional literal must not take the whole document with it.
 *
 * json-bigint sends every literal over 15 characters to `BigInt()` without
 * checking for a decimal point, so `0.05770000000000` and `773500.891234567`
 * both threw. On the replay path that is permanent: history replays from the
 * start on every reconnect, so a frame rejected once is rejected forever and
 * the head never gets a verified session.
 */

import { describe, expect, it } from '@jest/globals';

import { parseHydraJson } from './json';

describe('long fractional literals', () => {
	it('parses a drift report precise enough to exceed the BigInt threshold', () => {
		const parsed = parseHydraJson('{"tag":"SyncedStatusReport","drift":773500.891234567}') as {
			tag: string;
			drift: number;
		};

		expect(parsed.tag).toBe('SyncedStatusReport');
		expect(parsed.drift).toBe(773500.891234567);
	});

	it('parses a non-zero Plutus price rational written at full precision', () => {
		const parsed = parseHydraJson('{"executionUnitPrices":{"priceMemory":0.05770000000000}}') as {
			executionUnitPrices: { priceMemory: number };
		};

		expect(parsed.executionUnitPrices.priceMemory).toBe(0.0577);
	});

	it('keeps integer quantities exact in the same document', () => {
		const parsed = parseHydraJson('{"drift":773500.891234567,"value":{"lovelace":9007199254740993}}') as {
			drift: number;
			value: { lovelace: bigint };
		};

		expect(parsed.value.lovelace).toBe(9007199254740993n);
		expect(parsed.drift).toBe(773500.891234567);
	});

	it('leaves a matching literal inside a string as the string it was', () => {
		const parsed = parseHydraJson('{"note":"0.05770000000000","drift":773500.891234567}') as {
			note: string;
			drift: number;
		};

		expect(parsed.note).toBe('0.05770000000000');
		expect(parsed.drift).toBe(773500.891234567);
	});

	it('survives an escaped quote before the literal', () => {
		const parsed = parseHydraJson('{"note":"a \\" 1","drift":-773500.891234567}') as {
			note: string;
			drift: number;
		};

		expect(parsed.note).toBe('a " 1');
		expect(parsed.drift).toBe(-773500.891234567);
	});

	it('still reports malformed JSON as a parse failure', () => {
		expect(() => parseHydraJson('{"drift":773500.891234567,}')).toThrow();
		expect(() => parseHydraJson('{"drift":1,"drift":2}')).toThrow();
	});
});
