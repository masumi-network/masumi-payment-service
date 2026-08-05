import { describe, expect, it } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import { coverLovelace, IN_HEAD_COLLATERAL_RESERVE_LOVELACE, selectDecommittableUtxos, utxoRef } from './select';

function utxo(txHash: string, lovelace: bigint, extra: Partial<UTxO['output']> = {}, outputIndex = 0): UTxO {
	return {
		input: { txHash, outputIndex },
		output: {
			address: 'addr_test1_local',
			amount: [{ unit: 'lovelace', quantity: lovelace.toString() }],
			...extra,
		},
	} as UTxO;
}

const NO_PENDING = new Set<string>();

describe('selectDecommittableUtxos', () => {
	// The failure this exists to prevent: withdraw the last collateral-sized UTxO
	// and every future script spend in the head fails, while the balance still
	// looks healthy because the escrows themselves are untouched.
	it('holds back a collateral-sized UTxO', () => {
		const result = selectDecommittableUtxos({
			utxos: [utxo('a'.repeat(64), 20_000_000n), utxo('b'.repeat(64), 6_000_000n)],
			pendingIncrementRefs: NO_PENDING,
			drain: false,
		});

		expect(result.eligible).toHaveLength(1);
		expect(result.eligible[0]!.input.txHash).toBe('a'.repeat(64));
		expect(result.excluded.get(`${'b'.repeat(64)}#0`)).toContain('collateral');
	});

	// Smallest, so the reserve costs the withdrawal as little as it can.
	it('reserves the smallest UTxO that could serve as collateral', () => {
		const result = selectDecommittableUtxos({
			utxos: [utxo('a'.repeat(64), 30_000_000n), utxo('b'.repeat(64), 5_000_000n), utxo('c'.repeat(64), 9_000_000n)],
			pendingIncrementRefs: NO_PENDING,
			drain: false,
		});

		expect(result.excluded.has(`${'b'.repeat(64)}#0`)).toBe(true);
		expect(result.eligibleLovelace).toBe(39_000_000n);
	});

	// A UTxO too small to be collateral cannot protect anything, so withholding
	// one would cost the operator funds for no benefit.
	it('reserves nothing when no UTxO is large enough to be collateral', () => {
		const result = selectDecommittableUtxos({
			utxos: [utxo('a'.repeat(64), 2_000_000n), utxo('b'.repeat(64), 1_000_000n)],
			pendingIncrementRefs: NO_PENDING,
			drain: false,
		});

		expect(result.eligible).toHaveLength(2);
		expect(result.eligibleLovelace).toBe(3_000_000n);
	});

	it('takes the reserve too when draining', () => {
		const result = selectDecommittableUtxos({
			utxos: [utxo('a'.repeat(64), 20_000_000n), utxo('b'.repeat(64), 6_000_000n)],
			pendingIncrementRefs: NO_PENDING,
			drain: true,
		});

		expect(result.eligible).toHaveLength(2);
		expect(result.excluded.size).toBe(0);
	});

	// Between DepositActivated and CommitFinalized the head has promised these
	// funds but cannot spend them; building against one is refused as an input
	// that does not exist.
	it('excludes UTxOs still folding in from a deposit', () => {
		const pending = new Set([`${'a'.repeat(64)}#0`]);
		const result = selectDecommittableUtxos({
			utxos: [utxo('a'.repeat(64), 20_000_000n), utxo('b'.repeat(64), 20_000_000n)],
			pendingIncrementRefs: pending,
			drain: true,
		});

		expect(result.eligible).toHaveLength(1);
		expect(result.eligible[0]!.input.txHash).toBe('b'.repeat(64));
		expect(result.excluded.get(`${'a'.repeat(64)}#0`)).toContain('deposit');
	});

	// Anything with a datum is part of an arrangement rather than plain funds.
	// Taking it out would remove it from whatever depends on it while leaving
	// that thing looking intact.
	it('refuses UTxOs carrying a datum or a script', () => {
		const result = selectDecommittableUtxos({
			utxos: [
				utxo('a'.repeat(64), 20_000_000n, { dataHash: 'd'.repeat(64) }),
				utxo('b'.repeat(64), 20_000_000n, { scriptRef: 'ref' }),
				utxo('c'.repeat(64), 20_000_000n),
			],
			pendingIncrementRefs: NO_PENDING,
			drain: true,
		});

		expect(result.eligible).toHaveLength(1);
		expect(result.eligible[0]!.input.txHash).toBe('c'.repeat(64));
		expect(result.excluded.get(`${'a'.repeat(64)}#0`)).toContain('datum');
	});

	it('reports nothing eligible for an empty wallet', () => {
		const result = selectDecommittableUtxos({ utxos: [], pendingIncrementRefs: NO_PENDING, drain: false });

		expect(result.eligible).toHaveLength(0);
		expect(result.eligibleLovelace).toBe(0n);
	});

	it('names the reserve at the amount the collateral service actually needs', () => {
		expect(IN_HEAD_COLLATERAL_RESERVE_LOVELACE).toBe(5_000_000n);
	});
});

describe('coverLovelace', () => {
	// Largest first, so a withdrawal spends as few inputs as it can and leaves
	// the remaining UTxOs as usable as it found them.
	it('takes the fewest UTxOs that reach the amount', () => {
		const chosen = coverLovelace(
			[utxo('a'.repeat(64), 3_000_000n), utxo('b'.repeat(64), 20_000_000n), utxo('c'.repeat(64), 8_000_000n)],
			10_000_000n,
		);

		expect(chosen).not.toBeNull();
		expect(chosen).toHaveLength(1);
		expect(chosen![0]!.input.txHash).toBe('b'.repeat(64));
	});

	it('combines UTxOs when no single one is enough', () => {
		const chosen = coverLovelace([utxo('a'.repeat(64), 6_000_000n), utxo('b'.repeat(64), 7_000_000n)], 10_000_000n);

		expect(chosen).toHaveLength(2);
	});

	// Reported as a refusal rather than withdrawing an unexpected sum.
	it('returns null when the amount cannot be reached', () => {
		expect(coverLovelace([utxo('a'.repeat(64), 4_000_000n)], 10_000_000n)).toBeNull();
	});
});

describe('utxoRef', () => {
	it('normalises case so refs compare against the head consistently', () => {
		expect(utxoRef(utxo('A'.repeat(64), 1n, {}, 3))).toBe(`${'a'.repeat(64)}#3`);
	});
});
