import { describe, expect, it } from '@jest/globals';

import { parseHydraJson, stringifyHydraJson } from './json';

describe('Hydra lossless JSON', () => {
	it('round-trips integers above the JavaScript safe range exactly', () => {
		const parsed = parseHydraJson('{"quantity":9007199254740993}') as { quantity: bigint };

		expect(parsed.quantity).toBe(9007199254740993n);
		expect(stringifyHydraJson(parsed)).toContain('9007199254740993');
	});

	it('rejects unsafe numbers that have already been rounded by JavaScript', () => {
		expect(() => stringifyHydraJson({ quantity: Number.MAX_SAFE_INTEGER + 1 })).toThrow('inexact');
	});

	it('rejects duplicate keys and prototype-pollution properties', () => {
		expect(() => parseHydraJson('{"quantity":1,"quantity":2}')).toThrow();
		expect(() => parseHydraJson('{"__proto__":{"polluted":true}}')).toThrow();
	});

	it('preserves Plutus detailed-schema constructor fields on null-prototype objects', () => {
		const parsed = parseHydraJson('{"inlineDatum":{"constructor":0,"fields":[]}}') as {
			inlineDatum: { constructor: number; fields: unknown[] };
		};

		expect(Object.getPrototypeOf(parsed.inlineDatum)).toBeNull();
		expect(parsed.inlineDatum).toMatchObject({ constructor: 0, fields: [] });
	});
});
