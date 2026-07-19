import type { UTxO } from '@meshsdk/core';
import { selectCollateralUtxo, sortAndLimitUtxos, sortUtxosByLovelaceDesc } from './index';

type AssetSpec = { unit: string; quantity: string };

function makeUtxo(opts: { txHash?: string; outputIndex?: number; amount: AssetSpec[] }): UTxO {
	return {
		input: {
			txHash: opts.txHash ?? `tx-${Math.random().toString(36).slice(2, 10)}`,
			outputIndex: opts.outputIndex ?? 0,
		},
		output: {
			address: 'addr_test1qrtest',
			amount: opts.amount,
		},
	};
}

const lovelace = (qty: string | number): AssetSpec => ({
	unit: 'lovelace',
	quantity: typeof qty === 'number' ? qty.toString() : qty,
});

const TOKEN_UNIT = 'aaaa.deadbeef';
const token = (qty: string | number): AssetSpec => ({
	unit: TOKEN_UNIT,
	quantity: typeof qty === 'number' ? qty.toString() : qty,
});

describe('sortAndLimitUtxos', () => {
	it('stops as soon as accumulated lovelace exceeds requiredLovelace (single large UTxO case)', () => {
		const utxos = [makeUtxo({ amount: [lovelace(10_000_000)] }), makeUtxo({ amount: [lovelace(5_000_000)] })];
		const result = sortAndLimitUtxos(utxos, 8_000_000);
		// First UTxO alone (10 ADA) covers the 8 ADA target, so the second
		// shouldn't get pulled in even though it's also a valid candidate.
		// Note the accumulator continues "until > requiredLovelace" so an
		// exactly-equal first UTxO would still grab a second — current
		// behavior is documented here.
		expect(result.length).toBeGreaterThanOrEqual(1);
		const total = result.reduce((sum, u) => sum + parseInt(u.output.amount[0].quantity), 0);
		expect(total).toBeGreaterThan(8_000_000);
	});

	it('handles a wallet fragmented into many small UTxOs (worst-case post-5ADA-floor removal)', () => {
		// The pre-V2 limitUtxos rejected every UTxO below 5 ADA. The fix dropped
		// that filter; this test pins the post-fix behaviour so a future
		// regression that re-introduces the floor would fail loudly.
		const utxos = Array.from({ length: 50 }, (_, i) => makeUtxo({ outputIndex: i, amount: [lovelace(1_500_000)] }));
		const result = sortAndLimitUtxos(utxos, 8_000_000);
		// 8 / 1.5 = 5.33, accumulator continues until > target, so it should
		// pick ~6 UTxOs (6 × 1.5M = 9M > 8M).
		expect(result.length).toBeGreaterThanOrEqual(5);
		expect(result.length).toBeLessThanOrEqual(7);
		const total = result.reduce((sum, u) => sum + parseInt(u.output.amount[0].quantity), 0);
		expect(total).toBeGreaterThan(8_000_000);
	});

	it('combines sub-5-ADA UTxOs when no single one meets the target (was the V2-batch bug)', () => {
		// Reproduces the exact CI failure shape: buyer wallet collapsed to a
		// single ~2 ADA change UTxO after V2 batch-payments. Before the fix
		// limitUtxos threw "No suitable UTXOs found" because the 5 ADA filter
		// emptied the candidate set. Now: at least returns what's available.
		const utxos = [makeUtxo({ amount: [lovelace(2_000_000)] })];
		const result = sortAndLimitUtxos(utxos, 8_000_000);
		// Insufficient for the target but we should NOT throw — return what we
		// have and let Mesh's downstream coin selection / build raise a clear
		// "insufficient funds" if it really cannot balance.
		expect(result.length).toBe(1);
		expect(parseInt(result[0].output.amount[0].quantity)).toBe(2_000_000);
	});

	it('prefers pure-lovelace UTxOs over mixed UTxOs via the bloat-asc sort', () => {
		// sortUtxosByBloatAsc orders by `amount.length` ascending — a pure-ADA
		// UTxO has 1 asset entry, a mixed one has 2+. This is the only thing
		// preventing the accumulator from gratuitously dragging native-token
		// UTxOs into a fee-input slot.
		const utxos = [
			makeUtxo({ outputIndex: 0, amount: [lovelace(3_000_000), token(100)] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace(3_000_000)] }),
		];
		const result = sortAndLimitUtxos(utxos, 5_000_000);
		// Pure ADA UTxO sorts first, accumulator picks it first.
		expect(result[0].output.amount.length).toBe(1);
		expect(result[0].output.amount[0].unit).toBe('lovelace');
	});

	it('throws when every candidate has zero lovelace', () => {
		const utxos = [makeUtxo({ amount: [lovelace(0)] }), makeUtxo({ outputIndex: 1, amount: [lovelace(0)] })];
		expect(() => sortAndLimitUtxos(utxos, 8_000_000)).toThrow('No suitable UTXOs found');
	});

	it('throws on an empty utxo list', () => {
		expect(() => sortAndLimitUtxos([], 8_000_000)).toThrow('No suitable UTXOs found');
	});

	it('does not mutate the caller-provided utxo array', () => {
		// sortUtxosByBloatAsc internally uses .sort() which is in-place by default.
		// The function clones via .slice() first; this test pins that contract so a
		// future "just one less allocation" optimization can't re-introduce mutation.
		const utxos = [
			makeUtxo({ outputIndex: 0, amount: [lovelace(3_000_000), token(100)] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace(3_000_000)] }),
			makeUtxo({ outputIndex: 2, amount: [lovelace(3_000_000), token(50), token(25)] }),
		];
		const before = utxos.map((u) => u.input.outputIndex);
		sortAndLimitUtxos(utxos, 5_000_000);
		expect(utxos.map((u) => u.input.outputIndex)).toEqual(before);
	});
});

describe('sortUtxosByLovelaceDesc', () => {
	it('sorts by lovelace descending and is non-mutating', () => {
		const utxos = [
			makeUtxo({ outputIndex: 0, amount: [lovelace(1_000_000)] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace(5_000_000)] }),
			makeUtxo({ outputIndex: 2, amount: [lovelace(3_000_000)] }),
		];
		const before = utxos.map((u) => u.input.outputIndex);
		const result = sortUtxosByLovelaceDesc(utxos);
		expect(result.map((u) => parseInt(u.output.amount[0].quantity))).toEqual([5_000_000, 3_000_000, 1_000_000]);
		// Input order preserved (function should return a new array).
		expect(utxos.map((u) => u.input.outputIndex)).toEqual(before);
	});

	it('treats missing lovelace asset as 0', () => {
		const utxos = [
			makeUtxo({ outputIndex: 0, amount: [token(100)] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace(5_000_000)] }),
		];
		const result = sortUtxosByLovelaceDesc(utxos);
		expect(parseInt(result[0].output.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0')).toBe(5_000_000);
	});
});

describe('selectCollateralUtxo', () => {
	it('keeps the reported large ADA UTxO spendable by selecting the smaller qualifying collateral', () => {
		const small = makeUtxo({ txHash: 'small', amount: [lovelace(3_336_392)] });
		const collateral = makeUtxo({ txHash: 'collateral', amount: [lovelace(8_281_874)] });
		const large = makeUtxo({ txHash: 'large', amount: [lovelace(485_435_616)] });

		expect(selectCollateralUtxo([small, collateral, large]).input.txHash).toBe('collateral');
	});

	it('does not select a native-token UTxO as collateral', () => {
		const tokenBearing = makeUtxo({
			txHash: 'token-bearing',
			amount: [lovelace(6_000_000), token(1)],
		});

		expect(() => selectCollateralUtxo([tokenBearing])).toThrow('Pure-ADA collateral UTxO not found');
	});

	it('requires at least five ADA of pure collateral', () => {
		const dust = makeUtxo({ txHash: 'dust', amount: [lovelace(4_999_999)] });

		expect(() => selectCollateralUtxo([dust])).toThrow(
			'Pure-ADA collateral UTxO not found with at least 5000000 lovelace',
		);
	});
});
