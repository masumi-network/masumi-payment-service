/**
 * Pure helpers for the V2 Hydra L2 funds-lock path.
 *
 * Extracted from `l2-lock.ts` so the lock's value-bearing decisions — the buyer
 * return-address fallback, the PaidFunds → asset mapping, and the FundsLocked
 * datum shape — are unit-testable without the side-effecting wallet / provider /
 * prisma machinery around them.
 */
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
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
	return selected;
}

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
 * Build the datum params for an L2 (in-head) funds-lock. Identical shape to the
 * L1 lock but with `collateralReturnLovelace: 0n` (the head is zero-fee, so
 * there is no min-UTxO overestimation to absorb), no result, and zeroed
 * cooldowns — the initial FundsLocked state.
 */
export function buildL2LockDatumParams(args: {
	request: L2LockRequestFields;
	buyerAddress: string;
	sellerAddress: string;
	buyerReturnAddress: string | null;
}): V2DatumInput {
	const { request, buyerAddress, sellerAddress, buyerReturnAddress } = args;
	return {
		buyerAddress,
		buyerReturnAddress,
		sellerAddress,
		sellerReturnAddress: request.sellerReturnAddress,
		blockchainIdentifier: request.blockchainIdentifier,
		inputHash: request.inputHash,
		payByTime: request.payByTime,
		collateralReturnLovelace: 0n,
		resultHash: null,
		resultTime: request.submitResultTime,
		unlockTime: request.unlockTime,
		externalDisputeUnlockTime: request.externalDisputeUnlockTime,
		newCooldownTimeSeller: BigInt(0),
		newCooldownTimeBuyer: BigInt(0),
		state: SmartContractState.FundsLocked,
	};
}
