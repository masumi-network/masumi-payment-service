import { describe, expect, it } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import { IN_HEAD_COLLATERAL_RESERVE_LOVELACE } from '@/services/hydra-decommit/select';
import { MAX_CONSOLIDATION_INPUTS, planConsolidation } from './select';

const ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const COINS_PER_UTXO_SIZE = 4310;
const USDM = `${'c'.repeat(56)}0014df105553444d`;
const NO_PENDING = new Set<string>();

function utxo(index: number, lovelace: bigint, extra: Partial<UTxO['output']> = {}): UTxO {
	return {
		input: { txHash: index.toString(16).padStart(64, '0'), outputIndex: 0 },
		output: { address: ADDRESS, amount: [{ unit: 'lovelace', quantity: lovelace.toString() }], ...extra },
	} as UTxO;
}

function plan(utxos: UTxO[], pending: ReadonlySet<string> = NO_PENDING) {
	return planConsolidation({
		utxos,
		pendingIncrementRefs: pending,
		address: ADDRESS,
		coinsPerUtxoSize: COINS_PER_UTXO_SIZE,
	});
}

describe('planConsolidation', () => {
	it('spends every plain UTxO and splits off a collateral UTxO', () => {
		const result = plan([utxo(1, 2_000_000n), utxo(2, 3_000_000n), utxo(3, 50_000_000n)]);

		expect(result?.inputs).toHaveLength(3);
		expect(result?.collateralLovelace).toBe(IN_HEAD_COLLATERAL_RESERVE_LOVELACE);
		expect(result?.deferredCount).toBe(0);
	});

	// The reason this exists: V2 escrow payouts land at the buyer's key address
	// with a datum, and a selector that skips them sees a fraction of the balance.
	it('spends UTxOs that carry a datum', () => {
		const result = plan([
			utxo(1, 2_000_000n, { plutusData: 'd87980' }),
			utxo(2, 2_000_000n, { plutusData: 'd87980' }),
			utxo(3, 50_000_000n),
		]);

		expect(result?.inputs).toHaveLength(3);
	});

	it('leaves deposits still being folded in and reference scripts alone', () => {
		const pendingRef = `${(2).toString(16).padStart(64, '0')}#0`;
		const result = plan(
			[
				utxo(1, 2_000_000n),
				utxo(2, 9_000_000n),
				utxo(3, 9_000_000n, { scriptRef: 'abcd' }),
				utxo(4, 50_000_000n),
				utxo(5, 3_000_000n),
			],
			new Set([pendingRef]),
		);

		expect(result?.inputs.map((input) => input.input.txHash)).toEqual([
			(1).toString(16).padStart(64, '0'),
			(5).toString(16).padStart(64, '0'),
			(4).toString(16).padStart(64, '0'),
		]);
		expect(result?.excluded.size).toBe(2);
	});

	it('carries every token onto the merged output and still keeps collateral', () => {
		const result = plan([
			utxo(1, 1_500_000n, {
				amount: [
					{ unit: 'lovelace', quantity: '1500000' },
					{ unit: USDM, quantity: '1000000' },
				],
			}),
			utxo(2, 1_500_000n, {
				amount: [
					{ unit: 'lovelace', quantity: '1500000' },
					{ unit: USDM, quantity: '2000000' },
				],
			}),
			utxo(3, 20_000_000n),
		]);

		expect(result?.inputs).toHaveLength(3);
		expect(result?.collateralLovelace).toBe(IN_HEAD_COLLATERAL_RESERVE_LOVELACE);
	});

	// Splitting collateral off would strand the token output below its minimum.
	it('skips the collateral output when the rest could not exist without it', () => {
		const result = plan([
			utxo(1, 1_500_000n, {
				amount: [
					{ unit: 'lovelace', quantity: '1500000' },
					{ unit: USDM, quantity: '1' },
				],
			}),
			utxo(2, 1_500_000n, {
				amount: [
					{ unit: 'lovelace', quantity: '1500000' },
					{ unit: USDM, quantity: '1' },
				],
			}),
			utxo(3, 3_000_000n),
		]);

		expect(result?.collateralLovelace).toBeNull();
		expect(result?.inputs).toHaveLength(3);
	});

	it('returns null when there is nothing to merge', () => {
		expect(plan([])).toBeNull();
		expect(plan([utxo(1, 50_000_000n)])).toBeNull();
		// Two UTxOs into collateral plus the rest is still two UTxOs.
		expect(plan([utxo(1, 6_000_000n), utxo(2, 50_000_000n)])).toBeNull();
	});

	it('merges two small UTxOs that cannot spare collateral', () => {
		const result = plan([utxo(1, 2_000_000n), utxo(2, 2_000_000n)]);

		expect(result?.collateralLovelace).toBeNull();
		expect(result?.inputs).toHaveLength(2);
	});

	it('caps a round at the smallest UTxOs plus the largest', () => {
		const utxos = Array.from({ length: MAX_CONSOLIDATION_INPUTS + 20 }, (_, index) =>
			utxo(index + 1, BigInt(1_000_000 + index)),
		);
		utxos.push(utxo(9_999, 500_000_000n));
		const result = plan(utxos);

		expect(result?.inputs).toHaveLength(MAX_CONSOLIDATION_INPUTS);
		expect(result?.deferredCount).toBe(21);
		expect(result?.inputs.some((input) => input.input.txHash === (9_999).toString(16).padStart(64, '0'))).toBe(true);
		expect(result?.inputs.some((input) => input.input.txHash === (1).toString(16).padStart(64, '0'))).toBe(true);
	});
});
