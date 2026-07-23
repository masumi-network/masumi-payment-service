import { describe, expect, it } from '@jest/globals';
import type { Asset, UTxO } from '@meshsdk/core';
import { isPlainCommitUtxo, selectCommitUtxos } from './commit-utxos';

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

describe('selectCommitUtxos', () => {
	it('commits every plain wallet UTxO without reserving fuel', () => {
		const small = utxo(0, '10000000');
		const medium = utxo(1, '20000000');
		const large = utxo(2, '100000000');

		expect(selectCommitUtxos([medium, large, small])).toEqual({
			commitUtxos: [medium, large, small],
			excludedUtxos: [],
		});
	});

	it('excludes datum and reference-script outputs', () => {
		const commitA = utxo(0, '10000000');
		const commitB = utxo(1, '20000000');
		const datum = utxo(2, '30000000', { plutusData: 'd87980' });
		const referenceScript = utxo(3, '40000000', { scriptRef: '4e4d010000332222' });

		expect(selectCommitUtxos([commitA, datum, commitB, referenceScript])).toEqual({
			commitUtxos: [commitA, commitB],
			excludedUtxos: [datum, referenceScript],
		});
	});

	it('commits a single plain UTxO (the node funds fees from its own key)', () => {
		const only = utxo(0, '10000000');

		expect(selectCommitUtxos([only])).toEqual({
			commitUtxos: [only],
			excludedUtxos: [],
		});
	});

	it('returns no commit candidate when every UTxO is non-plain', () => {
		const datum = utxo(0, '10000000', { plutusData: 'd87980' });

		expect(selectCommitUtxos([datum])).toEqual({
			commitUtxos: [],
			excludedUtxos: [datum],
		});
	});
});
