import type { UTxO } from '@meshsdk/core';
import { classifyWalletState, COLLATERAL_RESERVE_LOVELACE, PREP_TX_MIN_LOVELACE } from './ensure-collateral-ready';

type AssetSpec = { unit: string; quantity: string };

function makeUtxo(opts: { txHash?: string; outputIndex?: number; amount: AssetSpec[] }): UTxO {
	return {
		input: {
			txHash: opts.txHash ?? 'tx-hash-placeholder',
			outputIndex: opts.outputIndex ?? 0,
		},
		output: {
			address: 'addr_test1qrtest',
			amount: opts.amount,
		},
	};
}

const lovelace = (qty: string): AssetSpec => ({ unit: 'lovelace', quantity: qty });
const TOKEN_UNIT = 'aaaa.deadbeef';
const token = (qty: string): AssetSpec => ({ unit: TOKEN_UNIT, quantity: qty });

describe('classifyWalletState', () => {
	it('flags ready when wallet has a pure 6 ADA UTxO and a pure 3 ADA UTxO', () => {
		const result = classifyWalletState([
			makeUtxo({ amount: [lovelace('6000000')] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace('3000000')] }),
		]);
		expect(result).toEqual({
			hasGoodCollateral: true,
			utxoCount: 2,
			totalLovelace: 9_000_000n,
			ready: true,
			fundedForPrep: true,
		});
	});

	it('refuses ready when only a single pure 6 ADA UTxO is present (and underfunded for prep)', () => {
		const result = classifyWalletState([makeUtxo({ amount: [lovelace('6000000')] })]);
		expect(result.hasGoodCollateral).toBe(true);
		expect(result.utxoCount).toBe(1);
		expect(result.totalLovelace).toBe(6_000_000n);
		expect(result.ready).toBe(false);
		// 6 ADA is below the 7 ADA prep budget — caller cannot self-fund a prep tx.
		expect(result.fundedForPrep).toBe(false);
	});

	it('refuses ready with a single pure 8 ADA UTxO but is funded for prep', () => {
		const result = classifyWalletState([makeUtxo({ amount: [lovelace('8000000')] })]);
		expect(result.hasGoodCollateral).toBe(true);
		expect(result.utxoCount).toBe(1);
		expect(result.totalLovelace).toBe(8_000_000n);
		// utxoCount == 1 disqualifies (no second input available for the fee
		// alongside the collateral input).
		expect(result.ready).toBe(false);
		// But >= 7 ADA → prep tx can be built.
		expect(result.fundedForPrep).toBe(true);
	});

	it('refuses ready when both UTxOs carry tokens (no pure-ADA collateral candidate)', () => {
		const result = classifyWalletState([
			makeUtxo({ amount: [lovelace('6000000'), token('100')] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace('3000000'), token('50')] }),
		]);
		expect(result.hasGoodCollateral).toBe(false);
		expect(result.utxoCount).toBe(2);
		expect(result.totalLovelace).toBe(9_000_000n);
		expect(result.ready).toBe(false);
		expect(result.fundedForPrep).toBe(true);
	});

	it('refuses ready when two pure UTxOs each fall below the 5 ADA collateral threshold', () => {
		const result = classifyWalletState([
			makeUtxo({ amount: [lovelace('4000000')] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace('3000000')] }),
		]);
		expect(result.hasGoodCollateral).toBe(false);
		expect(result.utxoCount).toBe(2);
		expect(result.totalLovelace).toBe(7_000_000n);
		expect(result.ready).toBe(false);
		expect(result.fundedForPrep).toBe(true);
	});

	it('refuses ready and prep on an empty wallet', () => {
		const result = classifyWalletState([]);
		expect(result).toEqual({
			hasGoodCollateral: false,
			utxoCount: 0,
			totalLovelace: 0n,
			ready: false,
			fundedForPrep: false,
		});
	});

	it('refuses ready and prep on a single zero-lovelace UTxO', () => {
		const result = classifyWalletState([makeUtxo({ amount: [lovelace('0')] })]);
		expect(result.hasGoodCollateral).toBe(false);
		expect(result.utxoCount).toBe(1);
		expect(result.totalLovelace).toBe(0n);
		expect(result.ready).toBe(false);
		expect(result.fundedForPrep).toBe(false);
	});

	it('uses the same threshold constants exported from the module', () => {
		// Guard against silent threshold drift in tests vs production logic.
		expect(COLLATERAL_RESERVE_LOVELACE).toBe(5_000_000n);
		expect(PREP_TX_MIN_LOVELACE).toBe(7_000_000n);
	});
});
