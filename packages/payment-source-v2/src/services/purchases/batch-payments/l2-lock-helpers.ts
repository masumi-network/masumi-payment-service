/**
 * Pure helpers for the V2 Hydra L2 funds-lock path.
 *
 * Extracted from `l2-lock.ts` so the lock's value-bearing decisions — the buyer
 * return-address fallback, the PaidFunds → asset mapping, and the FundsLocked
 * datum shape — are unit-testable without the side-effecting wallet / provider /
 * prisma machinery around them.
 */
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import { CONSTANTS } from '@masumi/payment-core/config';
import { createTxWindow, type TxWindow } from '@/services/shared/tx-window';
import type { V2DatumInput } from '../../../datum-builder';

/** Request fields the L2-lock datum reads (narrowed from the Prisma payload). */
export interface L2LockRequestFields {
	buyerReturnAddress: string | null;
	sellerReturnAddress: string | null;
	blockchainIdentifier: string;
	inputHash: string;
	payByTime: bigint;
	submitResultTime: bigint;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
}

/** A PaidFunds row (narrowed). */
export interface L2PaidFund {
	unit: string;
	amount: bigint;
}

export interface L2LockValuePlan {
	outputFunds: L2PaidFund[];
	collateralReturnLovelace: bigint;
	minUtxoLovelace: bigint;
}

/**
 * Add the ledger-required minimum ADA to a lock output without gifting it to
 * the seller. The added lovelace is recorded in the datum as buyer collateral
 * return, matching the L1 funds-lock invariant.
 *
 * `computeMinUtxo` receives the candidate collateral value because its CBOR
 * integer size contributes to the output's minimum-ADA requirement. Iterate to
 * a fixed point and verify the final plan instead of assuming one estimate is
 * enough.
 */
export function planL2LockValue(
	paidFunds: readonly L2PaidFund[],
	computeMinUtxo: (collateralReturnLovelace: bigint) => bigint,
): L2LockValuePlan {
	const requestedLovelace = paidFunds
		.filter((fund) => isLovelaceUnit(fund.unit))
		.reduce((sum, fund) => sum + fund.amount, 0n);
	if (paidFunds.length === 0 || requestedLovelace < 0n || paidFunds.some((fund) => fund.amount <= 0n)) {
		throw new Error('L2 lock paid funds must contain only positive amounts');
	}

	let collateralReturnLovelace = 0n;
	let minUtxoLovelace = 0n;
	for (let iteration = 0; iteration < 8; iteration += 1) {
		minUtxoLovelace = computeMinUtxo(collateralReturnLovelace);
		if (minUtxoLovelace < 0n) throw new Error('L2 lock minimum UTxO cannot be negative');
		let requiredTopUp = minUtxoLovelace > requestedLovelace ? minUtxoLovelace - requestedLovelace : 0n;
		if (requiredTopUp > 0n && requiredTopUp < CONSTANTS.MIN_COLLATERAL_LOVELACE) {
			requiredTopUp = CONSTANTS.MIN_COLLATERAL_LOVELACE;
		}
		if (requiredTopUp <= collateralReturnLovelace) break;
		collateralReturnLovelace = requiredTopUp;
	}

	minUtxoLovelace = computeMinUtxo(collateralReturnLovelace);
	if (requestedLovelace + collateralReturnLovelace < minUtxoLovelace) {
		throw new Error('L2 lock minimum UTxO calculation did not converge');
	}

	// Aggregate by unit: duplicate-unit PaidFunds rows must not produce duplicate
	// asset entries in the lock output (mesh Value behavior on duplicates is not
	// guaranteed). The selection side already aggregates; mirror it here.
	const aggregatedTokens = new Map<string, bigint>();
	for (const fund of paidFunds) {
		if (isLovelaceUnit(fund.unit)) continue;
		aggregatedTokens.set(fund.unit, (aggregatedTokens.get(fund.unit) ?? 0n) + fund.amount);
	}
	const outputFunds = [...aggregatedTokens.entries()].map(([unit, amount]) => ({ unit, amount }));
	if (requestedLovelace > 0n || collateralReturnLovelace > 0n) {
		outputFunds.push({ unit: '', amount: requestedLovelace + collateralReturnLovelace });
	}
	return { outputFunds, collateralReturnLovelace, minUtxoLovelace };
}

export type L2LockAttemptOutcome =
	| { status: 'accepted'; txHash: string }
	| { status: 'accepted-db-pending'; txHash: string; error: unknown }
	| { status: 'ambiguous'; intendedTxHash: string; error: unknown };

/** Every failure after initial-lock reservation is ambiguous, including TxInvalid. */
export function retainInitialL2LockAfterSubmitFailure(
	intendedTxHash: string,
	error: unknown,
): Extract<L2LockAttemptOutcome, { status: 'ambiguous' }> {
	return { status: 'ambiguous', intendedTxHash, error };
}

/**
 * hydra-node normally emits a fresh Tick roughly every 20 seconds. A clock
 * older than one minute is not strong enough evidence for a value-bearing
 * initial lock: the websocket may be disconnected while the last observed
 * chain time remains cached in memory.
 */
export const L2_LOCK_HEAD_CLOCK_MAX_AGE_MS = 60_000;
const L2_LOCK_HEAD_CLOCK_MAX_FUTURE_SKEW_MS = 5_000;

export interface L2LockHeadClock {
	chainTimeMs: number;
	receivedAtMs: number;
}

type CreateTxWindowOptions = NonNullable<Parameters<typeof createTxWindow>[1]>;

/**
 * Require live, recent head-clock evidence before an initial funds lock may be
 * built or reserved. Unlike later state transitions, initial lock moves new
 * value into escrow; falling back to wall clock when no Tick has been observed
 * can therefore lock funds for an already-expired request.
 */
export function requireFreshL2LockHeadClock(args: {
	headClock: L2LockHeadClock | undefined;
	payByTime: bigint;
	observedAtMs?: number;
	maxAgeMs?: number;
}): number {
	const { headClock, payByTime, observedAtMs = Date.now(), maxAgeMs = L2_LOCK_HEAD_CLOCK_MAX_AGE_MS } = args;
	if (!headClock) {
		throw new Error('L2 lock requires a live Hydra head clock');
	}
	if (!Number.isSafeInteger(observedAtMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0) {
		throw new Error('L2 lock head-clock freshness configuration is invalid');
	}
	if (
		!Number.isSafeInteger(headClock.chainTimeMs) ||
		headClock.chainTimeMs < 0 ||
		!Number.isSafeInteger(headClock.receivedAtMs) ||
		headClock.receivedAtMs < 0
	) {
		throw new Error('L2 lock received an invalid Hydra head clock');
	}
	if (headClock.receivedAtMs > observedAtMs + L2_LOCK_HEAD_CLOCK_MAX_FUTURE_SKEW_MS) {
		throw new Error('L2 lock received a Hydra head clock from the future');
	}
	if (headClock.chainTimeMs > observedAtMs + L2_LOCK_HEAD_CLOCK_MAX_FUTURE_SKEW_MS) {
		throw new Error('L2 lock received a Hydra chain time from the future');
	}
	if (observedAtMs - headClock.receivedAtMs > maxAgeMs) {
		throw new Error('L2 lock Hydra head clock is stale');
	}
	if (payByTime < 0n || payByTime > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new Error('L2 lock payByTime is outside the supported unix-ms range');
	}
	if (BigInt(headClock.chainTimeMs) >= payByTime) {
		throw new Error('L2 lock request has expired on the Hydra head clock');
	}
	return headClock.chainTimeMs;
}

/**
 * Build a body-bound validity interval for an initial lock. The live head clock
 * always replaces a possibly stale env/window anchor, while the caller's slot
 * config and buffer semantics are preserved. The postcondition is checked in
 * unix time so a future tx-window refactor cannot silently extend validity past
 * the datum's hard payByTime deadline.
 */
export function createTrustedL2LockWindow(args: {
	network: Parameters<typeof createTxWindow>[0];
	payByTime: bigint;
	headClock: L2LockHeadClock | undefined;
	observedAtMs?: number;
	windowOptions?: CreateTxWindowOptions;
}): TxWindow & { trustedHeadTimeMs: number } {
	const trustedHeadTimeMs = requireFreshL2LockHeadClock(args);
	const window = createTxWindow(args.network, {
		...args.windowOptions,
		nowMs: trustedHeadTimeMs,
		constrainAfterMs: args.payByTime,
	});
	if (!Number.isSafeInteger(window.invalidAfterMs) || BigInt(window.invalidAfterMs) > args.payByTime) {
		throw new Error('L2 lock validity upper bound exceeds payByTime');
	}
	return { ...window, trustedHeadTimeMs };
}

/** Match the L1 batch path's per-request HotWalletLimit semantics exactly. */
export function isHotWalletEligibleForL2Lock(
	request: { isLimitedToHotWallets: boolean; HotWalletLimit: ReadonlyArray<{ id: string }> },
	hotWalletId: string,
): boolean {
	return !request.isLimitedToHotWallets || request.HotWalletLimit.some((wallet) => wallet.id === hotWalletId);
}

/** Minimal shape of an in-head UTxO the funding selector needs. */
export interface L2FundingUtxo {
	input: { txHash: string; outputIndex: number };
	output: {
		address: string;
		amount: Array<{ unit: string; quantity: string }>;
		plutusData?: string | null;
	};
}

const isLovelaceUnit = (unit: string) => unit === '' || unit.toLowerCase() === 'lovelace';

const amountOfUnit = (u: L2FundingUtxo, unit: string): bigint =>
	BigInt(
		u.output.amount.find((a) => (unit === 'lovelace' ? isLovelaceUnit(a.unit) : a.unit === unit))?.quantity ?? '0',
	);

/**
 * Select in-head UTxOs to fund a lock. Handles ANY UTxO form and ANY asset:
 *
 *  - covers the paid funds (which may themselves include native tokens),
 *  - plus a splitter self-send + a min-UTxO change floor in lovelace,
 *  - draws from pure-ADA OR asset-carrying UTxOs alike — a faucet-bundled token
 *    on the buyer's ADA no longer disqualifies that UTxO. Leftover assets are
 *    returned to the change address by the caller's `changeAddress`.
 *
 * EXPLICIT selection on purpose: mesh's own coin selector re-resolves inputs via
 * `fetcher.fetchUTxOs(txHash)`, a per-tx query the snapshot-only Hydra provider
 * cannot answer, so `complete()` would hang. Here we hand mesh fully-specified
 * inputs and let it balance the (possibly multi-asset) change.
 *
 * Non-script UTxOs only — a UTxO carrying plutusData is an escrow output, not
 * spendable buyer funds. Largest-ADA first so the fewest inputs cover the need.
 * Throws (with the per-unit shortfall) when the wallet cannot cover the target.
 */
export function selectInHeadFundingUtxos<T extends L2FundingUtxo>(
	walletUtxos: readonly T[],
	paidFunds: readonly L2PaidFund[],
	splitterLovelace: bigint,
	minChangeLovelace: bigint,
	// Min-UTxO for the CHANGE output given the leftover assets it will carry.
	// The static `minChangeLovelace` floor alone under-shoots when asset-bearing
	// inputs leave several native tokens in the change — and that failure would
	// surface only at submitTx, AFTER the fail-closed reservation. Optional so
	// pure-ADA callers/tests keep the simple floor.
	computeChangeMinUtxo?: (changeAssets: Array<{ unit: string; quantity: bigint }>) => bigint,
): T[] {
	const spendable = walletUtxos
		.filter((u) => !u.output.plutusData)
		.slice()
		.sort((a, b) => Number(amountOfUnit(b, 'lovelace') - amountOfUnit(a, 'lovelace')));
	if (spendable.length === 0) {
		throw new Error('buyer wallet has no spendable (non-script) in-head UTxOs to fund the lock');
	}

	const required = new Map<string, bigint>();
	for (const f of paidFunds) {
		const unit = isLovelaceUnit(f.unit) ? 'lovelace' : f.unit;
		required.set(unit, (required.get(unit) ?? 0n) + f.amount);
	}
	required.set('lovelace', (required.get('lovelace') ?? 0n) + splitterLovelace + minChangeLovelace);

	const remaining = new Map(required);
	const covered = () => [...remaining.values()].every((v) => v <= 0n);
	const pending = spendable.slice();
	const selected: T[] = [];
	while (!covered() && pending.length > 0) {
		// Cover an outstanding non-ADA asset first (so token payments pull the
		// token-bearing UTxOs); otherwise take the largest-ADA UTxO.
		const neededAssets = [...remaining.entries()].filter(([u, v]) => u !== 'lovelace' && v > 0n).map(([u]) => u);
		let idx =
			neededAssets.length > 0 ? pending.findIndex((u) => neededAssets.some((unit) => amountOfUnit(u, unit) > 0n)) : 0;
		if (idx < 0) idx = 0;
		const [u] = pending.splice(idx, 1);
		selected.push(u);
		for (const unit of remaining.keys()) remaining.set(unit, remaining.get(unit)! - amountOfUnit(u, unit));
	}
	if (!covered()) {
		const missing = [...remaining.entries()]
			.filter(([, v]) => v > 0n)
			.map(([u, v]) => `${v.toString()} ${u}`)
			.join(', ');
		throw new Error(`insufficient in-head funds to lock: missing ${missing}`);
	}

	if (computeChangeMinUtxo) {
		// The change output carries every leftover asset from the selected inputs;
		// its real min-UTxO grows with the asset count. Top up the lovelace target
		// until the leftover lovelace covers max(static floor, change min-UTxO).
		// Prefer pure-ADA inputs when topping up so the change asset set (and thus
		// the requirement) does not grow further. Runs pre-reservation, so an
		// impossible target throws on the safe side of the reservation.
		for (;;) {
			const selectedTotals = new Map<string, bigint>();
			for (const u of selected) {
				for (const a of u.output.amount) {
					const unit = isLovelaceUnit(a.unit) ? 'lovelace' : a.unit;
					selectedTotals.set(unit, (selectedTotals.get(unit) ?? 0n) + BigInt(a.quantity));
				}
			}
			const changeAssets = [...selectedTotals.entries()]
				.filter(([unit]) => unit !== 'lovelace')
				.map(([unit, total]) => ({ unit, quantity: total - (required.get(unit) ?? 0n) }))
				.filter((a) => a.quantity > 0n);
			const changeFloor = computeChangeMinUtxo(changeAssets);
			const requiredLovelace =
				(required.get('lovelace') ?? 0n) - minChangeLovelace + maxBigInt(minChangeLovelace, changeFloor);
			const selectedLovelace = selectedTotals.get('lovelace') ?? 0n;
			if (selectedLovelace >= requiredLovelace) break;
			if (pending.length === 0) {
				throw new Error(
					`insufficient in-head funds to lock: change output needs ${maxBigInt(minChangeLovelace, changeFloor).toString()} lovelace min-UTxO (${changeAssets.length.toString()} leftover assets), short ${(requiredLovelace - selectedLovelace).toString()} lovelace`,
				);
			}
			const pureAdaIdx = pending.findIndex((u) => u.output.amount.every((a) => isLovelaceUnit(a.unit)));
			const [topUp] = pending.splice(pureAdaIdx >= 0 ? pureAdaIdx : 0, 1);
			selected.push(topUp);
		}
	}
	return selected;
}

const maxBigInt = (a: bigint, b: bigint): bigint => (a > b ? a : b);

/**
 * The buyer's return address falls back to the lock wallet's collection address
 * when the request did not specify one. Both may be null (the datum field is
 * nullable), so the result can be null when neither is set.
 */
export function resolveL2BuyerReturnAddress(
	requestBuyerReturnAddress: string | null,
	walletCollectionAddress: string | null,
): string | null {
	return requestBuyerReturnAddress ?? walletCollectionAddress;
}

/**
 * Map PaidFunds rows to Mesh asset specs. An empty `unit` denotes ADA and is
 * normalised to the `'lovelace'` unit the builder expects.
 */
export function mapPaidFundsToAssets(paidFunds: readonly L2PaidFund[]): Array<{ unit: string; quantity: string }> {
	return paidFunds.map((amount) => ({
		unit: amount.unit === '' ? 'lovelace' : amount.unit,
		quantity: amount.amount.toString(),
	}));
}

/**
 * Build the datum params for an L2 (in-head) funds-lock. The calculated
 * minimum-ADA top-up is retained as buyer collateral return; result/cooldowns
 * remain empty for the initial FundsLocked state.
 */
export function buildL2LockDatumParams(args: {
	request: L2LockRequestFields;
	buyerAddress: string;
	sellerAddress: string;
	buyerReturnAddress: string | null;
	collateralReturnLovelace: bigint;
}): V2DatumInput {
	const { request, buyerAddress, sellerAddress, buyerReturnAddress, collateralReturnLovelace } = args;
	return {
		buyerAddress,
		buyerReturnAddress,
		sellerAddress,
		sellerReturnAddress: request.sellerReturnAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		inputHash: request.inputHash,
		payByTime: request.payByTime,
		collateralReturnLovelace,
		resultHash: null,
		resultTime: request.submitResultTime,
		unlockTime: request.unlockTime,
		externalDisputeUnlockTime: request.externalDisputeUnlockTime,
		newCooldownTimeSeller: BigInt(0),
		newCooldownTimeBuyer: BigInt(0),
		state: SmartContractState.FundsLocked,
	};
}
