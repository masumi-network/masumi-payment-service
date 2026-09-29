import { describe, expect, it } from '@jest/globals';
import { serializePlutusScript } from '@meshsdk/core';
import { calculateMinUtxo } from '@/utils/min-utxo';
import { walletDatumData, type WalletDatum } from './wallet';
import { coinsPerUtxoSizeOf, guardedContinuingMinLovelace } from './guarded-lock-builder';

const PREPROD_COINS_PER_UTXO_SIZE = 4310;
const ADDRESS = serializePlutusScript(
	{ code: '4e4d01000033222220051200120011', version: 'V3' },
	'cd'.repeat(28),
	0,
).address;
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

function longToken(index: number) {
	return { unit: `${index.toString(16).padStart(2, '0').repeat(28)}${'ee'.repeat(32)}`, quantity: String(10n ** 15n) };
}

function minFor(amount: Array<{ unit: string; quantity: string }>, extraBytes?: number) {
	return guardedContinuingMinLovelace({
		address: ADDRESS,
		datum,
		amount,
		coinsPerUtxoSize: PREPROD_COINS_PER_UTXO_SIZE,
		extraBytes,
	});
}

describe('guardedContinuingMinLovelace', () => {
	it('is above the 1.02 ADA Mesh gives a bare inline-datum output', () => {
		expect(minFor([STATE_TOKEN])).toBeGreaterThan(1_021_470n);
	});

	it('is above the buffered estimate when the wallet holds many long-named tokens', () => {
		// The buffered estimate counts 50 bytes per token; a 32-byte name under its own policy takes more.
		const tokens = [STATE_TOKEN, ...Array.from({ length: 7 }, (_, i) => longToken(i + 1))];
		const buffered = calculateMinUtxo({
			datum: walletDatumData(datum),
			nativeTokenCount: tokens.length,
			coinsPerUtxoSize: PREPROD_COINS_PER_UTXO_SIZE,
			includeBuffers: true,
		}).minUtxoLovelace;
		expect(minFor(tokens)).toBeGreaterThan(buffered);
	});

	it.each([
		['the state token only, where the buffered estimate decides', [STATE_TOKEN]],
		[
			'many long-named tokens, where the serialized size decides',
			[STATE_TOKEN, ...Array.from({ length: 8 }, (_, i) => longToken(i + 1))],
		],
	])('adds the datum growth margin for %s', (_label, tokens) => {
		expect(minFor(tokens, 32) - minFor(tokens)).toBe(32n * BigInt(PREPROD_COINS_PER_UTXO_SIZE));
	});
});

describe('coinsPerUtxoSizeOf', () => {
	it('reads the number and refuses parameters without it', () => {
		expect(coinsPerUtxoSizeOf({ coinsPerUtxoSize: PREPROD_COINS_PER_UTXO_SIZE })).toBe(PREPROD_COINS_PER_UTXO_SIZE);
		expect(() => coinsPerUtxoSizeOf({})).toThrow('coinsPerUtxoSize');
	});
});
