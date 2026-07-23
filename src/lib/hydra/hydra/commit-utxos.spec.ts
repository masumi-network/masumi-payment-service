import { describe, expect, it } from '@jest/globals';
import type { Asset, UTxO } from '@meshsdk/core';
import { isPlainCommitUtxo, selectCommitUtxos, selectCommitUtxosUpToTarget } from './commit-utxos';

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

	describe('asset filter', () => {
		const USDM = 'aa'.repeat(28) + '0014df10';
		const adaOnly = utxo(0, '10000000');
		const withToken: UTxO = {
			input: { txHash: 'tx-1', outputIndex: 1 },
			output: {
				address: 'addr_test1participant',
				amount: [
					{ unit: 'lovelace', quantity: '5000000' },
					{ unit: USDM, quantity: '2000000000' },
				],
			},
		};

		it('ada-only commits only pure-lovelace UTxOs', () => {
			expect(selectCommitUtxos([adaOnly, withToken], 'ada-only')).toEqual({
				commitUtxos: [adaOnly],
				excludedUtxos: [withToken],
			});
		});

		it('{ unit } commits only UTxOs containing that asset (case-insensitive)', () => {
			expect(selectCommitUtxos([adaOnly, withToken], { unit: USDM.toUpperCase() })).toEqual({
				commitUtxos: [withToken],
				excludedUtxos: [adaOnly],
			});
		});

		it('all (default) commits both', () => {
			expect(selectCommitUtxos([adaOnly, withToken], 'all').commitUtxos).toEqual([adaOnly, withToken]);
		});
	});
});

describe('selectCommitUtxosUpToTarget', () => {
	const target = (amount: bigint) => ({ unit: 'lovelace', amount });

	it('commits the minimal largest-first set reaching the target', () => {
		const small = utxo(0, '10000000');
		const medium = utxo(1, '20000000');
		const large = utxo(2, '100000000');

		const result = selectCommitUtxosUpToTarget([small, medium, large], 'all', target(30_000_000n));

		// large (100M) alone already reaches 30M
		expect(result.commitUtxos).toEqual([large]);
		expect(result.excludedUtxos).toEqual(expect.arrayContaining([small, medium]));
	});

	it('accumulates multiple UTxOs when one is not enough', () => {
		const a = utxo(0, '10000000');
		const b = utxo(1, '9000000');
		const c = utxo(2, '8000000');

		const result = selectCommitUtxosUpToTarget([a, b, c], 'all', target(18_000_000n));

		// 10M + 9M = 19M >= 18M
		expect(result.commitUtxos).toEqual([a, b]);
	});

	it('commits everything matching (best effort) when the target is unreachable', () => {
		const a = utxo(0, '10000000');
		const b = utxo(1, '5000000');

		const result = selectCommitUtxosUpToTarget([a, b], 'all', target(1_000_000_000n));

		expect(result.commitUtxos).toEqual(expect.arrayContaining([a, b]));
		expect(result.commitUtxos).toHaveLength(2);
	});

	it('bounds by a token unit and excludes non-matching UTxOs', () => {
		const USDM = 'bb'.repeat(28) + '0014df10';
		const adaOnly = utxo(0, '10000000');
		const tokenA: UTxO = {
			input: { txHash: 'tok-a', outputIndex: 0 },
			output: {
				address: 'addr_test1participant',
				amount: [
					{ unit: 'lovelace', quantity: '2000000' },
					{ unit: USDM, quantity: '600' },
				],
			},
		};
		const tokenB: UTxO = {
			input: { txHash: 'tok-b', outputIndex: 0 },
			output: {
				address: 'addr_test1participant',
				amount: [
					{ unit: 'lovelace', quantity: '2000000' },
					{ unit: USDM, quantity: '500' },
				],
			},
		};

		const result = selectCommitUtxosUpToTarget([adaOnly, tokenA, tokenB], { unit: USDM }, { unit: USDM, amount: 550n });

		// tokenA (600) alone reaches 550; ada-only excluded by the filter
		expect(result.commitUtxos).toEqual([tokenA]);
		expect(result.excludedUtxos).toEqual(expect.arrayContaining([adaOnly, tokenB]));
	});
});
