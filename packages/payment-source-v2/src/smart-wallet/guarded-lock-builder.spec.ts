import { describe, expect, it } from '@jest/globals';
import type { WalletDatum } from './wallet';
import { coinsPerUtxoSizeOf, guardedContinuingMinLovelace } from './guarded-lock-builder';

const PREPROD_COINS_PER_UTXO_SIZE = 4310;
const STATE_TOKEN = { unit: `${'c'.repeat(56)}${'d'.repeat(64)}`, quantity: '1' };

function lovelaceValue(quantity: bigint) {
	return new Map([['', new Map([['', quantity]])]]);
}

const datum: WalletDatum = {
	agent: 'a'.repeat(56),
	limit: lovelaceValue(1_000_000_000n),
	periodLength: 86_400_000n,
	periodStart: 1_000_000n,
	spentInPeriod: lovelaceValue(0n),
	minBalanceLovelace: 0n,
};

describe('guardedContinuingMinLovelace', () => {
	it('is above the 1.02 ADA Mesh gives a bare inline-datum output', () => {
		const min = guardedContinuingMinLovelace(
			datum,
			[{ unit: 'lovelace', quantity: '0' }, STATE_TOKEN],
			PREPROD_COINS_PER_UTXO_SIZE,
		);
		expect(min).toBeGreaterThan(1_021_470n);
	});

	it('grows with each native token the output carries', () => {
		const withToken = guardedContinuingMinLovelace(datum, [STATE_TOKEN], PREPROD_COINS_PER_UTXO_SIZE);
		const withoutToken = guardedContinuingMinLovelace(datum, [], PREPROD_COINS_PER_UTXO_SIZE);
		expect(withToken).toBeGreaterThan(withoutToken);
	});
});

describe('coinsPerUtxoSizeOf', () => {
	it('reads the number and refuses parameters without it', () => {
		expect(coinsPerUtxoSizeOf({ coinsPerUtxoSize: PREPROD_COINS_PER_UTXO_SIZE })).toBe(PREPROD_COINS_PER_UTXO_SIZE);
		expect(() => coinsPerUtxoSizeOf({})).toThrow('coinsPerUtxoSize');
	});
});
