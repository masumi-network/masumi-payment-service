import { describe, expect, it } from '@jest/globals';
import type { UTxO } from '@meshsdk/core';
import {
	coverLovelace,
	IN_HEAD_COLLATERAL_RESERVE_LOVELACE,
	isAlreadyCarved,
	requiredChangeLovelace,
	selectDecommittableUtxos,
	topUpCarveInputs,
	utxoRef,
} from './select';

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

describe('isAlreadyCarved', () => {
	const TOKEN = 'aa'.repeat(28) + '7444';
	const CARRIER = 2_000_000n;

	function tokenUtxo(lovelace: bigint, quantity: bigint, extraUnit?: string): UTxO {
		const amount = [
			{ unit: 'lovelace', quantity: lovelace.toString() },
			{ unit: TOKEN, quantity: quantity.toString() },
		];
		if (extraUnit) amount.push({ unit: extraUnit, quantity: '1' });
		return utxo('carve', lovelace, { amount });
	}

	// The bug this exists to prevent: a withdrawal of 1000 tUSDM that also sent
	// out the 450 ADA the token happened to share a UTxO with, because the
	// quantity matched and a decommit takes whole outputs.
	it('refuses to spend whole when the UTxO carries more ADA than a carrier needs', () => {
		expect(isAlreadyCarved([tokenUtxo(450_000_000n, 1000n)], TOKEN, 1000n, CARRIER)).toBe(false);
	});

	it('accepts a UTxO that already is what the carve would produce', () => {
		expect(isAlreadyCarved([tokenUtxo(CARRIER, 1000n)], TOKEN, 1000n, CARRIER)).toBe(true);
	});

	it('refuses when another asset would leave with it', () => {
		expect(isAlreadyCarved([tokenUtxo(CARRIER, 1000n, 'bb'.repeat(28))], TOKEN, 1000n, CARRIER)).toBe(false);
	});

	it('refuses when the quantity does not match exactly', () => {
		expect(isAlreadyCarved([tokenUtxo(CARRIER, 1500n)], TOKEN, 1000n, CARRIER)).toBe(false);
	});

	// Two inputs cannot be the output of a carve, whatever they add up to.
	it('refuses more than one input', () => {
		expect(isAlreadyCarved([tokenUtxo(CARRIER, 500n), tokenUtxo(CARRIER, 500n)], TOKEN, 1000n, CARRIER)).toBe(false);
	});

	it('refuses an empty set', () => {
		expect(isAlreadyCarved([], TOKEN, 1000n, CARRIER)).toBe(false);
	});
});

describe('topUpCarveInputs', () => {
	const TOKEN = 'cc'.repeat(28) + '7444';
	const NEEDED = 4_000_000n;

	function tokenUtxo(txHash: string, lovelace: bigint): UTxO {
		return utxo(txHash, lovelace, {
			amount: [
				{ unit: 'lovelace', quantity: lovelace.toString() },
				{ unit: TOKEN, quantity: '1000' },
			],
		});
	}

	// The case that made partial token withdrawals impossible: a token minted
	// onto a bare minimum-ADA UTxO cannot fund the two outputs a carve produces.
	it('borrows lovelace when the token’s own UTxO cannot fund the carve', () => {
		const holder = tokenUtxo('holder', 1_200_000n);
		const spare = utxo('spare', 10_000_000n);

		const extra = topUpCarveInputs({ chosen: [holder], eligible: [holder, spare], needed: NEEDED });

		expect(extra).toEqual([spare]);
	});

	// Smallest first, so topping the carve up leaves the bigger UTxOs whole.
	it('takes the smallest UTxOs that get there', () => {
		const holder = tokenUtxo('holder', 1_000_000n);
		const small = utxo('small', 3_500_000n);
		const large = utxo('large', 50_000_000n);

		const extra = topUpCarveInputs({ chosen: [holder], eligible: [holder, large, small], needed: NEEDED });

		expect(extra).toEqual([small]);
	});

	it('borrows nothing when the inputs already cover it', () => {
		const holder = tokenUtxo('holder', 9_000_000n);

		expect(topUpCarveInputs({ chosen: [holder], eligible: [holder], needed: NEEDED })).toEqual([]);
	});

	// Reported as a refusal rather than a carve that cannot be built.
	it('returns null when the whole head falls short', () => {
		const holder = tokenUtxo('holder', 1_000_000n);

		expect(topUpCarveInputs({ chosen: [holder], eligible: [holder], needed: NEEDED })).toBeNull();
	});

	// Borrowing a token-heavy UTxO puts its assets on the carve's change, where
	// minimum ADA grows with them. Prefer plain lovelace even when it is larger.
	it('prefers an asset-free UTxO over a smaller token-bearing one', () => {
		const holder = tokenUtxo('holder', 1_000_000n);
		const tokenHeavy = utxo('heavy', 3_200_000n, {
			amount: [
				{ unit: 'lovelace', quantity: '3200000' },
				{ unit: 'ee'.repeat(28), quantity: '1' },
			],
		});
		const plain = utxo('plain', 8_000_000n);

		const extra = topUpCarveInputs({
			chosen: [holder],
			eligible: [holder, tokenHeavy, plain],
			needed: NEEDED,
		});

		expect(extra).toEqual([plain]);
	});

	// A UTxO already being spent must not be counted twice.
	it('never returns a UTxO that is already an input', () => {
		const holder = tokenUtxo('holder', 1_000_000n);
		const spare = utxo('spare', 10_000_000n);

		const extra = topUpCarveInputs({ chosen: [holder, spare], eligible: [holder, spare], needed: NEEDED });

		expect(extra).toEqual([]);
	});
});

describe('requiredChangeLovelace', () => {
	const BASE = 2_000_000n;
	const PER_ASSET = 500_000n;
	const TOKEN = 'dd'.repeat(28) + '7444';
	const OTHER = 'ee'.repeat(28);

	function withAssets(assets: Array<{ unit: string; quantity: string }>): UTxO {
		return utxo('input', 10_000_000n, {
			amount: [{ unit: 'lovelace', quantity: '10000000' }, ...assets],
		});
	}

	it('charges only the base when nothing stays on the change', () => {
		const inputs = [withAssets([{ unit: TOKEN, quantity: '100' }])];

		expect(
			requiredChangeLovelace({
				inputs,
				carvedUnit: TOKEN,
				carvedAmount: 100n,
				baseLovelace: BASE,
				perAssetLovelace: PER_ASSET,
			}),
		).toBe(BASE);
	});

	// The failure this prevents: borrowing a token-heavy UTxO puts every one of
	// its assets on the change, where minimum ADA grows with them, and a flat
	// floor let the split be built and then refused by the ledger.
	it('charges per asset that stays behind', () => {
		const inputs = [
			withAssets([
				{ unit: TOKEN, quantity: '100' },
				{ unit: OTHER, quantity: '1' },
			]),
		];

		expect(
			requiredChangeLovelace({
				inputs,
				carvedUnit: TOKEN,
				carvedAmount: 40n,
				baseLovelace: BASE,
				perAssetLovelace: PER_ASSET,
			}),
		).toBe(BASE + PER_ASSET * 2n);
	});

	it('counts a lovelace carve as leaving every asset behind', () => {
		const inputs = [withAssets([{ unit: TOKEN, quantity: '100' }])];

		expect(
			requiredChangeLovelace({
				inputs,
				carvedUnit: '',
				carvedAmount: 1_000_000n,
				baseLovelace: BASE,
				perAssetLovelace: PER_ASSET,
			}),
		).toBe(BASE + PER_ASSET);
	});
});
