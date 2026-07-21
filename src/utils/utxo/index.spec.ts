import type { UTxO } from '@meshsdk/core';
import {
	getLovelaceFromUtxo,
	getSpendableWalletUtxos,
	selectCollateralUtxo,
	sortAndLimitUtxos,
	sortUtxosByLovelaceDesc,
} from './index';

function createUtxo(id: string, lovelace: bigint, nativeAssets: Array<{ unit: string; quantity: string }> = []): UTxO {
	return {
		input: {
			txHash: id,
			outputIndex: 0,
		},
		output: {
			address: 'addr_test1...',
			amount: [{ unit: 'lovelace', quantity: lovelace.toString() }, ...nativeAssets],
		},
	} as UTxO;
}

describe('UTxO selection', () => {
	it('selects the large pure-ADA input from the reported wallet balance', () => {
		const utxos = [
			createUtxo('nft', 3_289_334n, [
				{ unit: 'policy.asset-1', quantity: '1' },
				{ unit: 'policy.asset-2', quantity: '1' },
			]),
			createUtxo('pure-3a', 3_336_392n),
			createUtxo('pure-3b', 3_132_080n),
			createUtxo('usdm-1', 5_896_080n, [{ unit: 'c48c47ad', quantity: '1900000' }]),
			createUtxo('usdm-2', 5_896_080n, [{ unit: 'c48c47ad', quantity: '1900000' }]),
			createUtxo('collateral', 8_281_874n),
			createUtxo('large', 485_435_616n),
		];

		const selected = sortAndLimitUtxos(utxos, 8_000_000n);

		expect(selected.map((utxo) => utxo.input.txHash)).toEqual(['large']);
		expect(selectCollateralUtxo(utxos).input.txHash).toBe('collateral');
	});

	it('combines inputs below five ADA instead of discarding them', () => {
		const selected = sortAndLimitUtxos([createUtxo('first', 4_000_000n), createUtxo('second', 4_000_000n)], 8_000_000n);

		expect(selected).toHaveLength(2);
		expect(selected.reduce((total, utxo) => total + getLovelaceFromUtxo(utxo), 0n)).toBe(8_000_000n);
	});

	it('sorts lovelace with bigint precision and does not mutate the input', () => {
		const smaller = createUtxo('smaller', 9_007_199_254_740_992n);
		const larger = createUtxo('larger', 9_007_199_254_740_993n);
		const utxos = [smaller, larger];

		expect(sortUtxosByLovelaceDesc(utxos).map((utxo) => utxo.input.txHash)).toEqual(['larger', 'smaller']);
		expect(utxos.map((utxo) => utxo.input.txHash)).toEqual(['smaller', 'larger']);
	});

	it('prefers pure ADA over a smaller mixed-asset collateral candidate', () => {
		const mixed = createUtxo('mixed', 6_000_000n, [{ unit: 'policy.asset', quantity: '1' }]);
		const pure = createUtxo('pure', 8_000_000n);

		expect(selectCollateralUtxo([mixed, pure]).input.txHash).toBe('pure');
	});

	it('falls back to mixed-asset collateral when no pure-ADA candidate qualifies', () => {
		const largeMixed = createUtxo('large-mixed', 12_000_000n, [{ unit: 'policy.asset', quantity: '1' }]);
		const smallMixed = createUtxo('small-mixed', 6_000_000n, [{ unit: 'policy.asset', quantity: '1' }]);

		expect(selectCollateralUtxo([largeMixed, smallMixed]).input.txHash).toBe('small-mixed');
	});

	it('reports when no collateral input meets the minimum', () => {
		expect(() => selectCollateralUtxo([createUtxo('small', 4_999_999n)])).toThrow(
			'Collateral UTxO not found with at least 5000000 lovelace',
		);
	});

	it('reports an insufficient aggregate UTxO balance', () => {
		expect(() => sortAndLimitUtxos([createUtxo('small', 4_000_000n)], 8_000_000n)).toThrow('Insufficient UTxO balance');
	});
});

describe('getSpendableWalletUtxos', () => {
	it('keeps the collateral reserve out of the coin-selection candidates', () => {
		const collateral = createUtxo('collateral', 8_000_000n);
		const utxos = [createUtxo('a', 10_000_000n), collateral, createUtxo('b', 20_000_000n)];

		expect(getSpendableWalletUtxos(utxos, collateral).map((utxo) => utxo.input.txHash)).toEqual(['a', 'b']);
	});

	it('matches the collateral on output index, not just tx hash', () => {
		const collateral = { ...createUtxo('shared', 8_000_000n), input: { txHash: 'shared', outputIndex: 1 } } as UTxO;
		const sibling = createUtxo('shared', 9_000_000n); // outputIndex 0

		expect(getSpendableWalletUtxos([sibling, collateral], collateral).map((utxo) => utxo.input.outputIndex)).toEqual([
			0,
		]);
	});

	it('falls back to the unfiltered set when the collateral is the only UTxO', () => {
		const collateral = createUtxo('collateral', 8_000_000n);

		expect(getSpendableWalletUtxos([collateral], collateral)).toEqual([collateral]);
	});
});
