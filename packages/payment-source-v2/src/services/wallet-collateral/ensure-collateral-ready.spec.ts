import type { UTxO } from '@meshsdk/core';
import {
	buildUnlockWalletLockData,
	classifyWalletState,
	COLLATERAL_RESERVE_LOVELACE,
	PREP_TX_MIN_LOVELACE,
} from './ensure-collateral-ready';

// Integration tests for the side-effecting `ensureCollateralReady` path
// (insufficient_funds / prep_tx_failed branches that mutate DB + on-chain)
// require jest module mocks of `@masumi/payment-core/db`, `@/services/shared`,
// and `@masumi/payment-core/logger`. Under jest's ESM-mode runner those
// mocks need `jest.unstable_mockModule(...)` + dynamic `await import(...)`,
// which is brittle and has produced flakes here. The pure-function
// `classifyWalletState` gate below is fully covered, and the side-effecting
// paths are exercised end-to-end by `tests/e2e/v2/flows/batch-verification.test.ts`
// (the cold-start buyer wallet consistently triggers a `deferred` prep tx
// — surfaced in CI via the `[collateral-prep]` workflow annotator) and by
// observing the helper's WARN/ERROR logs in failure scenarios.

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
			pureLovelaceTotal: 9_000_000n,
			hasPureAdaUtxo: true,
			utxoAssetSummaries: [
				{ txHash: 'tx-hash-placeholder', outputIndex: 0, lovelace: '6000000', assetUnits: [] },
				{ txHash: 'tx-hash-placeholder', outputIndex: 1, lovelace: '3000000', assetUnits: [] },
			],
			ready: true,
			fundedForPrep: true,
		});
	});

	it('refuses ready when only a single pure 6 ADA UTxO is present (and underfunded for prep)', () => {
		const result = classifyWalletState([makeUtxo({ amount: [lovelace('6000000')] })]);
		expect(result.hasGoodCollateral).toBe(true);
		expect(result.utxoCount).toBe(1);
		expect(result.totalLovelace).toBe(6_000_000n);
		expect(result.pureLovelaceTotal).toBe(6_000_000n);
		expect(result.ready).toBe(false);
		// 6 ADA is below the 7 ADA prep budget — caller cannot self-fund a prep tx.
		expect(result.fundedForPrep).toBe(false);
	});

	it('refuses ready with a single pure 8 ADA UTxO but is funded for prep', () => {
		const result = classifyWalletState([makeUtxo({ amount: [lovelace('8000000')] })]);
		expect(result.hasGoodCollateral).toBe(true);
		expect(result.utxoCount).toBe(1);
		expect(result.totalLovelace).toBe(8_000_000n);
		expect(result.pureLovelaceTotal).toBe(8_000_000n);
		// utxoCount == 1 disqualifies (no second input available for the fee
		// alongside the collateral input).
		expect(result.ready).toBe(false);
		// But >= 7 ADA pure-ADA → prep tx can be built.
		expect(result.fundedForPrep).toBe(true);
	});

	it('refuses ready AND fundedForPrep when both UTxOs carry tokens (no pure-ADA pool for prep)', () => {
		const result = classifyWalletState([
			makeUtxo({ amount: [lovelace('6000000'), token('100')] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace('3000000'), token('50')] }),
		]);
		expect(result.hasGoodCollateral).toBe(false);
		expect(result.utxoCount).toBe(2);
		expect(result.totalLovelace).toBe(9_000_000n);
		// All lovelace is trapped in token-bearing UTxOs — mesh's prep-tx
		// `sendAssets` cannot peel pure ADA off them, so fundedForPrep is false
		// even though totalLovelace clears the 7 ADA threshold.
		expect(result.pureLovelaceTotal).toBe(0n);
		expect(result.hasPureAdaUtxo).toBe(false);
		expect(result.ready).toBe(false);
		expect(result.fundedForPrep).toBe(false);
	});

	it('refuses ready when two pure UTxOs each fall below the 5 ADA collateral threshold', () => {
		const result = classifyWalletState([
			makeUtxo({ amount: [lovelace('4000000')] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace('3000000')] }),
		]);
		expect(result.hasGoodCollateral).toBe(false);
		expect(result.utxoCount).toBe(2);
		expect(result.totalLovelace).toBe(7_000_000n);
		expect(result.pureLovelaceTotal).toBe(7_000_000n);
		expect(result.ready).toBe(false);
		expect(result.fundedForPrep).toBe(true);
	});

	it('refuses ready and prep on an empty wallet', () => {
		const result = classifyWalletState([]);
		expect(result).toEqual({
			hasGoodCollateral: false,
			utxoCount: 0,
			totalLovelace: 0n,
			pureLovelaceTotal: 0n,
			hasPureAdaUtxo: false,
			utxoAssetSummaries: [],
			ready: false,
			fundedForPrep: false,
		});
	});

	it('refuses ready and prep on a single zero-lovelace UTxO', () => {
		const result = classifyWalletState([makeUtxo({ amount: [lovelace('0')] })]);
		expect(result.hasGoodCollateral).toBe(false);
		expect(result.utxoCount).toBe(1);
		expect(result.totalLovelace).toBe(0n);
		expect(result.pureLovelaceTotal).toBe(0n);
		expect(result.ready).toBe(false);
		expect(result.fundedForPrep).toBe(false);
	});

	it('reports per-UTxO asset summaries with token units listed for token-bearing UTxOs', () => {
		const result = classifyWalletState([
			makeUtxo({ amount: [lovelace('5000000'), token('100')] }),
			makeUtxo({ outputIndex: 1, amount: [lovelace('3000000')] }),
		]);
		expect(result.utxoAssetSummaries).toEqual([
			{ txHash: 'tx-hash-placeholder', outputIndex: 0, lovelace: '5000000', assetUnits: [TOKEN_UNIT] },
			{ txHash: 'tx-hash-placeholder', outputIndex: 1, lovelace: '3000000', assetUnits: [] },
		]);
		// Only the second (pure) UTxO contributes to pureLovelaceTotal.
		expect(result.pureLovelaceTotal).toBe(3_000_000n);
	});

	it('uses the same threshold constants exported from the module', () => {
		// Guard against silent threshold drift in tests vs production logic.
		expect(COLLATERAL_RESERVE_LOVELACE).toBe(5_000_000n);
		expect(PREP_TX_MIN_LOVELACE).toBe(7_000_000n);
	});
});

describe('buildUnlockWalletLockData', () => {
	// Pins the exact Prisma update payload produced by `unlockWalletLock`'s
	// internal helper. The two fields MUST stay in lockstep:
	//   - `lockedAt: null` clears the outer mutex from `lockAndQueryX`.
	//   - `PendingTransaction.disconnect: true` defensively releases any
	//     accidentally-connected pending tx (the invariant says there is
	//     none, but a future caller violating that should not silently
	//     leak a pendingTransactionId lock).
	// A regression that drops either field would re-introduce wallet-lock
	// leaks documented in ADR-0007.
	it('produces both lockedAt clear AND PendingTransaction disconnect', () => {
		const payload = buildUnlockWalletLockData();
		expect(payload).toEqual({
			lockedAt: null,
			PendingTransaction: { disconnect: true },
		});
	});

	it('PendingTransaction.disconnect is the literal `true`, not a falsy value', () => {
		const payload = buildUnlockWalletLockData();
		// Prisma's `disconnect: true` semantics differ from `disconnect: false`
		// (latter is a no-op). Pin the literal so a typo doesn't silently
		// degrade to "do nothing".
		expect(payload.PendingTransaction.disconnect).toBe(true);
	});
});

// Side-effecting branch coverage (insufficient_funds, prep_tx_failed_db,
// prep_tx_failed_submit, deferred) is provided by
// `tests/e2e/v2/flows/batch-verification.test.ts` — see the explanatory
// comment at the top of this file for the full rationale.
