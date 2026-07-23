import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { TransactionLayer } from '@/generated/prisma/client';
import { transactionLayerToForceLayerApi } from '@/utils/logic/force-layer';

/** Serialize a transaction record for API responses: BigInt fees → string. */
function transformTransactionWithFees<T extends { fees: bigint | null }>(
	tx: T,
): Omit<T, 'fees'> & { fees: string | null } {
	return { ...tx, fees: tx.fees?.toString() ?? null };
}

export function transformCurrentTransaction<T extends { fees: bigint | null }>(tx: T | null) {
	return tx ? transformTransactionWithFees(tx) : null;
}

export function transformTransactionHistory<T extends { fees: bigint | null }>(history: T[] | null | undefined) {
	return history ? history.map(transformTransactionWithFees) : null;
}

/** Prefer the synced agentIdentifier, fall back to decoding it from the blockchain identifier. */
export function resolveAgentIdentifier(record: {
	agentIdentifier: string | null;
	blockchainIdentifier: string;
}): string | null {
	return record.agentIdentifier ?? decodeBlockchainIdentifier(record.blockchainIdentifier)?.agentIdentifier ?? null;
}

export function transformBigIntAmounts<T extends { unit: string; amount: bigint }>(
	amounts: T[],
): Array<{ unit: string; amount: string }> {
	return amounts.map((amount) => ({
		unit: amount.unit,
		amount: amount.amount.toString(),
	}));
}

export function normalizePurchaseUnit(unit: string) {
	return unit.toLowerCase() === 'lovelace' ? '' : unit;
}

export function transformPaymentGetAmounts(payment: {
	RequestedFunds: Array<{ unit: string; amount: bigint }>;
	WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
	WithdrawnForBuyer: Array<{ unit: string; amount: bigint }>;
}) {
	return {
		RequestedFunds: (payment.RequestedFunds as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			...amount,
			amount: amount.amount.toString(),
		})),
		WithdrawnForSeller: (payment.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
		WithdrawnForBuyer: (payment.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
	};
}

export function transformPurchaseGetAmounts(purchase: {
	PaidFunds: Array<{ unit: string; amount: bigint }>;
	WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
	WithdrawnForBuyer: Array<{ unit: string; amount: bigint }>;
}) {
	return {
		PaidFunds: (purchase.PaidFunds as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			...amount,
			amount: amount.amount.toString(),
		})),
		WithdrawnForSeller: (purchase.WithdrawnForSeller as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
		WithdrawnForBuyer: (purchase.WithdrawnForBuyer as Array<{ unit: string; amount: bigint }>).map((amount) => ({
			unit: amount.unit,
			amount: amount.amount.toString(),
		})),
	};
}

export function transformPaymentGetTimestamps(payment: {
	submitResultTime: bigint;
	payByTime: bigint | null;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	collateralReturnLovelace?: bigint | null;
	sellerCoolDownTime: bigint;
	buyerCoolDownTime: bigint;
	forceLayer: TransactionLayer | null;
}) {
	return {
		submitResultTime: payment.submitResultTime.toString(),
		payByTime: payment.payByTime?.toString() ?? null,
		unlockTime: payment.unlockTime.toString(),
		externalDisputeUnlockTime: payment.externalDisputeUnlockTime.toString(),
		collateralReturnLovelace: payment.collateralReturnLovelace?.toString() ?? null,
		cooldownTime: Number(payment.sellerCoolDownTime),
		cooldownTimeOtherParty: Number(payment.buyerCoolDownTime),
		// Map the stored DB layer (L1/L2) back to the API vocabulary (L1/Hydra).
		// Folded into this shared transformer so every payment-returning endpoint
		// exposes forceLayer consistently.
		forceLayer: transactionLayerToForceLayerApi(payment.forceLayer),
	};
}

export function transformPurchaseGetTimestamps(purchase: {
	submitResultTime: bigint;
	payByTime: bigint | null;
	unlockTime: bigint;
	externalDisputeUnlockTime: bigint;
	collateralReturnLovelace?: bigint | null;
	buyerCoolDownTime: bigint;
	sellerCoolDownTime: bigint;
	forceLayer: TransactionLayer | null;
	paymentForceLayer: TransactionLayer | null;
}) {
	return {
		submitResultTime: purchase.submitResultTime.toString(),
		payByTime: purchase.payByTime?.toString() ?? null,
		unlockTime: purchase.unlockTime.toString(),
		externalDisputeUnlockTime: purchase.externalDisputeUnlockTime.toString(),
		collateralReturnLovelace: purchase.collateralReturnLovelace?.toString() ?? null,
		cooldownTime: Number(purchase.buyerCoolDownTime),
		cooldownTimeOtherParty: Number(purchase.sellerCoolDownTime),
		// Map the stored DB layer (L1/L2) back to the API vocabulary (L1/Hydra).
		// Folded into this shared transformer so every purchase-returning endpoint
		// exposes forceLayer consistently.
		forceLayer: transactionLayerToForceLayerApi(purchase.forceLayer),
		paymentForceLayer: transactionLayerToForceLayerApi(purchase.paymentForceLayer),
	};
}
