import { describe, expect, it } from '@jest/globals';
import { getOutputMinLovelace } from '@meshsdk/core';
import { assertDecommitOutputMinimum } from './min-output';

const ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const COINS_PER_BYTE = 4310;

describe('exact Hydra withdrawal output minimum', () => {
	it('rejects a positive ADA amount too small to exist', () => {
		expect(() =>
			assertDecommitOutputMinimum(ADDRESS, [{ unit: 'lovelace', quantity: '34480' }], COINS_PER_BYTE),
		).toThrow('requires at least');
	});

	it('accepts the serializer minimum without changing the exact amount', () => {
		const amount = [{ unit: 'lovelace', quantity: '2000000' }];
		const minimum = getOutputMinLovelace({ address: ADDRESS, amount }, COINS_PER_BYTE);
		amount[0].quantity = minimum.toString();
		expect(() => assertDecommitOutputMinimum(ADDRESS, amount, COINS_PER_BYTE)).not.toThrow();
		expect(amount[0].quantity).toBe(minimum.toString());
	});

	it('checks the token carrier against the actual head rate', () => {
		const amount = [
			{ unit: 'lovelace', quantity: '2000000' },
			{ unit: 'ab'.repeat(28) + 'cd'.repeat(32), quantity: '900000' },
		];
		expect(() => assertDecommitOutputMinimum(ADDRESS, amount, COINS_PER_BYTE)).not.toThrow();
		expect(() => assertDecommitOutputMinimum(ADDRESS, amount, COINS_PER_BYTE * 3)).toThrow('requires at least');
	});

	it('fails closed on an invalid head minimum rate', () => {
		expect(() => assertDecommitOutputMinimum(ADDRESS, [], Number.NaN)).toThrow('invalid coinsPerUtxoSize');
	});
});
