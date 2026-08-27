import { describe, expect, it } from '@jest/globals';
import { feeShareForPaymentKey, feeShareForPaymentKeys, splitFeeEvenly } from './fee-split';

describe('splitFeeEvenly', () => {
	it('divides a fee that splits exactly', () => {
		expect(splitFeeEvenly(300n, 3)).toEqual([100n, 100n, 100n]);
	});

	it('keeps the shares adding up to the fee when it does not divide exactly', () => {
		const shares = splitFeeEvenly(100n, 3);
		expect(shares).toEqual([34n, 33n, 33n]);
		expect(shares.reduce((total, share) => total + share, 0n)).toBe(100n);
	});

	it('gives the whole fee to a batch of one', () => {
		expect(splitFeeEvenly(175_000n, 1)).toEqual([175_000n]);
	});

	it('refuses a batch of no requests, because there is nothing to charge', () => {
		expect(() => splitFeeEvenly(10n, 0)).toThrow(RangeError);
	});

	it('refuses a negative fee', () => {
		expect(() => splitFeeEvenly(-1n, 2)).toThrow(RangeError);
	});
});

describe('feeShareForPaymentKey', () => {
	it('gives every request in a batch of three its third', () => {
		const keys = ['charlie', 'alpha', 'bravo'];
		expect(feeShareForPaymentKey(300n, keys, 'alpha')).toBe(100n);
		expect(feeShareForPaymentKey(300n, keys, 'bravo')).toBe(100n);
		expect(feeShareForPaymentKey(300n, keys, 'charlie')).toBe(100n);
	});

	it('shares the remainder by sorted key, so the order of the input cannot change a share', () => {
		const shares = (keys: string[]) => keys.map((key) => feeShareForPaymentKey(100n, keys, key));
		expect(shares(['alpha', 'bravo', 'charlie'])).toEqual([34n, 33n, 33n]);
		expect(shares(['charlie', 'bravo', 'alpha'])).toEqual([33n, 33n, 34n]);
	});

	it('orders mixed case by code point, so the remainder does not follow the runtime locale', () => {
		// `localeCompare` puts 'apple' before 'Banana' and 'apple' before 'Zulu'.
		// Code point order puts every capital first. The remainder goes to the
		// earliest shares, so the two orders disagree about who pays the extra
		// lovelace. Code point order is the same on every runtime and locale.
		const keys = ['apple', 'Banana', 'Zulu'];
		expect(feeShareForPaymentKey(100n, keys, 'Banana')).toBe(34n);
		expect(feeShareForPaymentKey(100n, keys, 'Zulu')).toBe(33n);
		expect(feeShareForPaymentKey(100n, keys, 'apple')).toBe(33n);
	});

	it('counts a repeated key once', () => {
		expect(feeShareForPaymentKey(100n, ['alpha', 'alpha'], 'alpha')).toBe(100n);
	});

	it('charges nothing to a request outside the batch', () => {
		expect(feeShareForPaymentKey(300n, ['alpha', 'bravo'], 'delta')).toBeNull();
	});
});

describe('feeShareForPaymentKeys', () => {
	it('takes only the shares of the requests the report can see', () => {
		expect(feeShareForPaymentKeys(300n, ['alpha', 'bravo', 'charlie'], new Set(['alpha', 'charlie']))).toBe(200n);
	});

	it('takes the whole fee when the report holds the whole batch', () => {
		expect(feeShareForPaymentKeys(100n, ['alpha', 'bravo'], new Set(['alpha', 'bravo']))).toBe(100n);
	});

	it('takes nothing when the report holds none of the batch', () => {
		expect(feeShareForPaymentKeys(300n, ['alpha'], new Set(['delta']))).toBe(0n);
	});
});
