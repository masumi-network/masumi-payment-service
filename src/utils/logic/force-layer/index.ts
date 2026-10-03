/**
 * Optional per-request L1 vs Hydra (L2) routing override.
 *
 * API surface uses the caller-friendly `"L1" | "Hydra"`; internally it maps to
 * the `TransactionLayer` enum (L1/L2). Null = auto (L2 if a head is available,
 * else L1 — the default behavior).
 */
import { TransactionLayer } from '@/generated/prisma/client';

export type ForceLayerApi = 'L1' | 'Hydra';

/** The API enum values, for building the zod input schema. */
export const FORCE_LAYER_API_VALUES = ['L1', 'Hydra'] as const;

export function forceLayerApiToTransactionLayer(value: ForceLayerApi | null | undefined): TransactionLayer | null {
	if (value === 'L1') return TransactionLayer.L1;
	if (value === 'Hydra') return TransactionLayer.L2;
	return null;
}

export function transactionLayerToForceLayerApi(value: TransactionLayer | null | undefined): ForceLayerApi | null {
	if (value === TransactionLayer.L1) return 'L1';
	if (value === TransactionLayer.L2) return 'Hydra';
	return null;
}

/**
 * The effective forced layer for a purchase's funds-lock, combining the buyer's
 * own `forceLayer` with the paired payment's (the seller's). Returns:
 *  - a TransactionLayer when either side forces one (and they don't conflict),
 *  - `'conflict'` when both sides force DIFFERENT layers (the lock must fail),
 *  - `null` when neither forces (auto routing).
 */
export function resolveEffectiveForceLayer(
	purchaseForce: TransactionLayer | null,
	paymentForce: TransactionLayer | null,
): TransactionLayer | 'conflict' | null {
	if (purchaseForce != null && paymentForce != null && purchaseForce !== paymentForce) {
		return 'conflict';
	}
	return purchaseForce ?? paymentForce ?? null;
}

/**
 * Whether a request already has durable Hydra ownership. L1 sync must not take
 * over such a row merely because it sees a matching identifier on L1.
 */
export function hasHydraRequestOwnership(request: {
	layer: TransactionLayer;
	currentHydraUtxoTxHash: string | null;
	currentHydraUtxoOutputIndex: number | null;
	CurrentTransaction: { layer: TransactionLayer; hydraHeadId?: string | null } | null;
}): boolean {
	return (
		request.layer === TransactionLayer.L2 ||
		request.CurrentTransaction?.layer === TransactionLayer.L2 ||
		request.currentHydraUtxoTxHash != null ||
		request.currentHydraUtxoOutputIndex != null
	);
}

export function canL1ObservationOwnPaymentRequest(
	request: Parameters<typeof hasHydraRequestOwnership>[0] & { forceLayer: TransactionLayer | null },
): boolean {
	const isVerifiedFanoutHandoff =
		request.layer === TransactionLayer.L1 && request.CurrentTransaction?.layer === TransactionLayer.L1;
	return !hasHydraRequestOwnership(request) && (request.forceLayer !== TransactionLayer.L2 || isVerifiedFanoutHandoff);
}

export function canL1ObservationOwnPurchaseRequest(
	request: Parameters<typeof hasHydraRequestOwnership>[0] & {
		forceLayer: TransactionLayer | null;
		paymentForceLayer: TransactionLayer | null;
	},
): boolean {
	const effectiveForceLayer = resolveEffectiveForceLayer(request.forceLayer, request.paymentForceLayer);
	const isVerifiedFanoutHandoff =
		request.layer === TransactionLayer.L1 && request.CurrentTransaction?.layer === TransactionLayer.L1;
	return (
		!hasHydraRequestOwnership(request) &&
		(isVerifiedFanoutHandoff || (effectiveForceLayer !== TransactionLayer.L2 && effectiveForceLayer !== 'conflict'))
	);
}
