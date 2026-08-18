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

	it('commits a single UTxO that reaches the target on its own', () => {
		const small = utxo(0, '10000000');
		const medium = utxo(1, '20000000');
		const large = utxo(2, '100000000');

		const result = selectCommitUtxosUpToTarget([small, medium, large], 'all', target(30_000_000n));

		// large (100M) is the only one that reaches 30M by itself
		expect(result.commitUtxos).toEqual([large]);
		expect(result.excludedUtxos).toEqual(expect.arrayContaining([small, medium]));
	});

	// Hydra commits whole UTxOs, so the excess over the target is the entire
	// question. Taking the largest first put a wallet's whole balance into the
	// head for a 10 ADA rule — recoverable only by a decommit or a close.
	it('prefers the smallest UTxO that covers the target on its own', () => {
		const small = utxo(0, '10000000');
		const sufficient = utxo(1, '50000000');
		const whole_wallet = utxo(2, '5000000000');

		const result = selectCommitUtxosUpToTarget([small, sufficient, whole_wallet], 'all', target(30_000_000n));

		expect(result.commitUtxos).toEqual([sufficient]);
		expect(result.excludedUtxos).toEqual(expect.arrayContaining([small, whole_wallet]));
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

// An unreachable target does not produce an empty selection — it produces EVERY
// matching UTxO, best effort. A caller that reads "non-empty" as "worked" then
// commits the whole wallet balance, and the wallet that pays L1 fees for
// collections, results and refunds is left empty until someone decommits or
// closes the head.
describe('reachedTarget', () => {
	it('is false when the wallet cannot cover the target, even though UTxOs were chosen', () => {
		const selection = selectCommitUtxosUpToTarget([utxo(0, '60000000'), utxo(1, '60000000')], 'ada-only', {
			unit: 'lovelace',
			amount: 500_000_000n,
		});

		expect(selection.commitUtxos).toHaveLength(2);
		expect(selection.reachedTarget).toBe(false);
	});

	it('is true when a single UTxO covers it', () => {
		const selection = selectCommitUtxosUpToTarget([utxo(0, '600000000')], 'ada-only', {
			unit: 'lovelace',
			amount: 500_000_000n,
		});

		expect(selection.reachedTarget).toBe(true);
	});

	it('is true when several together cover it', () => {
		const selection = selectCommitUtxosUpToTarget([utxo(0, '300000000'), utxo(1, '300000000')], 'ada-only', {
			unit: 'lovelace',
			amount: 500_000_000n,
		});

		expect(selection.reachedTarget).toBe(true);
	});
});

// Hydra commits WHOLE UTxOs, and a wallet's change consolidates, so the
// smallest UTxO covering a token amount is routinely one that also carries the
// agent's registry NFT.
describe('exclusive token filter', () => {
	const TOKEN = `${'cc'.repeat(28)}0014df10`;
	const OTHER = `${'dd'.repeat(28)}0014df10`;

	const mixed = utxo(0, '3000000', {
		amount: [
			{ unit: 'lovelace', quantity: '3000000' },
			{ unit: TOKEN, quantity: '800' },
			{ unit: OTHER, quantity: '1' },
		],
	});
	const clean = utxo(1, '3000000', {
		amount: [
			{ unit: 'lovelace', quantity: '3000000' },
			{ unit: TOKEN, quantity: '800' },
		],
	});

	it('refuses a UTxO that carries another native asset alongside the target', () => {
		const selection = selectCommitUtxos([mixed, clean], { unit: TOKEN, exclusive: true });

		expect(selection.commitUtxos).toEqual([clean]);
		expect(selection.excludedUtxos).toEqual([mixed]);
	});

	it('still admits both without the flag, which is what the manual path asks for', () => {
		expect(selectCommitUtxos([mixed, clean], { unit: TOKEN }).commitUtxos).toEqual([mixed, clean]);
	});
});
