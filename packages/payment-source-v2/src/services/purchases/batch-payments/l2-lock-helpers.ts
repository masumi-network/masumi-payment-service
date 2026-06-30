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
