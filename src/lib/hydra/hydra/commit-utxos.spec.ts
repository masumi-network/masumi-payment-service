import { describe, expect, it } from '@jest/globals';
import type { Asset, UTxO } from '@meshsdk/core';
import { isPlainCommitUtxo, selectCommitUtxosWithFuelReserve } from './commit-utxos';

function utxo(index: number, lovelace: string, output: Partial<UTxO['output']> = {}): UTxO {
	const amount: Asset[] = [{ unit: 'lovelace', quantity: lovelace }];
	return {
		input: { txHash: `tx-${index}`, outputIndex: index },
		output: {
			address: 'addr_test1participant',
			amount,
			...output,
		},
	};
}

describe('isPlainCommitUtxo', () => {
	it('accepts a datum-free pubkey output', () => {
		expect(isPlainCommitUtxo(utxo(0, '10000000'))).toBe(true);
	});

	it.each([
		['inline datum', { plutusData: 'd87980' }],
		['datum hash', { dataHash: 'datum-hash' }],
		['reference script', { scriptRef: '4e4d010000332222' }],
	] as const)('rejects an output carrying %s', (_name, output) => {
		expect(isPlainCommitUtxo(utxo(0, '10000000', output))).toBe(false);
	});
});

describe('selectCommitUtxosWithFuelReserve', () => {
	it('commits only UTxOs strictly smaller than the largest fee-fuel UTxO', () => {
		const small = utxo(0, '10000000');
		const medium = utxo(1, '20000000');
		const fuel = utxo(2, '100000000');

		expect(selectCommitUtxosWithFuelReserve([medium, fuel, small])).toEqual({
			commitUtxos: [medium, small],
			fuelUtxos: [fuel],
			excludedUtxos: [],
		});
	});

	it('reserves all largest ties so fee selection cannot collide with a commit input', () => {
		const commit = utxo(0, '10000000');
		const fuelA = utxo(1, '100000000');
		const fuelB = utxo(2, '100000000');

		expect(selectCommitUtxosWithFuelReserve([fuelA, commit, fuelB])).toEqual({
			commitUtxos: [commit],
			fuelUtxos: [fuelA, fuelB],
			excludedUtxos: [],
		});
	});

	it('excludes datum and reference-script outputs before selecting fuel', () => {
		const commit = utxo(0, '10000000');
		const fuel = utxo(1, '20000000');
		const datum = utxo(2, '30000000', { plutusData: 'd87980' });
		const referenceScript = utxo(3, '40000000', { scriptRef: '4e4d010000332222' });

		expect(selectCommitUtxosWithFuelReserve([commit, datum, fuel, referenceScript])).toEqual({
			commitUtxos: [commit],
			fuelUtxos: [fuel],
			excludedUtxos: [datum, referenceScript],
		});
	});

	it('returns no commit candidate when no strictly larger fuel UTxO exists', () => {
		const only = utxo(0, '10000000');

		expect(selectCommitUtxosWithFuelReserve([only])).toEqual({
			commitUtxos: [],
			fuelUtxos: [only],
			excludedUtxos: [],
		});
	});

	it('compares lovelace losslessly above the JavaScript safe-integer limit', () => {
		const commit = utxo(0, '9007199254740993');
		const fuel = utxo(1, '9007199254740994');

		expect(selectCommitUtxosWithFuelReserve([fuel, commit])).toEqual({
			commitUtxos: [commit],
			fuelUtxos: [fuel],
			excludedUtxos: [],
		});
	});
});
