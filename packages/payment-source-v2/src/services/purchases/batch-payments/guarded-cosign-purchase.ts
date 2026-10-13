import { PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import type { Asset } from '@meshsdk/core';
import { jobHashOf, type CosignIntent } from '../../../smart-wallet/cosign-client';
import { assetUnitOf } from '../../../smart-wallet/governed-asset';
import type { CosignDisposition } from './cosign-disposition';

/** The purchase fields a guarded lock shows the co-signer, on L1 and inside a head alike. */
type GuardedPurchase = {
	id: string;
	nextActionId: string;
	agentIdentifier: string | null;
	blockchainIdentifier: string;
	inputHash: string | null;
	PaidFunds: Array<{ unit: string; amount: bigint }>;
	SellerWallet: { walletVkey: string };
};

/**
 * The escrow output of a guarded lock, and the amount of `governedAsset` the
 * co-signer is shown. The output carries every unit the purchase pays, so a
 * token purchase also carries its min-UTxO lovelace. Packing and L2 routing
 * keep other purchases away (`guardedPurchaseFits`); this throw is the backstop.
 */
export function guardedLockValue(
	purchase: Pick<GuardedPurchase, 'id' | 'PaidFunds'>,
	governedAsset: string,
): { amount: Asset[]; governedAmount: bigint } {
	const sums = new Map<string, bigint>();
	for (const funds of purchase.PaidFunds) {
		const unit = funds.unit === '' || funds.unit.toLowerCase() === 'lovelace' ? 'lovelace' : funds.unit;
		sums.set(unit, (sums.get(unit) ?? 0n) + funds.amount);
	}
	const governedUnit = assetUnitOf(governedAsset);
	for (const unit of sums.keys()) {
		if (unit !== 'lovelace' && unit !== governedUnit) {
			throw new Error(`this guarded wallet pays in ${governedAsset}; purchase ${purchase.id} carries ${unit}`);
		}
	}
	const governedAmount = sums.get(governedUnit) ?? 0n;
	if (governedAmount <= 0n) throw new Error(`purchase ${purchase.id} pays no ${governedAsset}`);
	return {
		amount: [...sums].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() })),
		governedAmount,
	};
}

/** `amount` is the escrow output's quantity of `asset` (Exchain form), which the co-signer checks the body against. */
export function cosignIntentFor(
	purchase: GuardedPurchase,
	outputIndex: number,
	asset: string,
	amount: bigint,
): CosignIntent {
	const agentIdentifier =
		purchase.agentIdentifier ?? decodeBlockchainIdentifier(purchase.blockchainIdentifier)?.agentIdentifier;
	if (agentIdentifier == null) {
		throw new Error(`purchase ${purchase.id} has no agent identifier to show the co-signer`);
	}
	if (purchase.inputHash == null) throw new Error(`purchase ${purchase.id} has no input hash`);
	return {
		purchaseId: purchase.id,
		outputIndex,
		counterparty: `sellerVkeyHash:${purchase.SellerWallet.walletVkey}`,
		amount: amount.toString(),
		asset,
		jobHash: jobHashOf(purchase.inputHash),
		agentIdentifier,
	};
}

/** Park or requeue the purchases the quorum did not co-sign. Nothing was submitted for them. */
export async function recordCosignDispositionsFor(
	purchases: Array<Pick<GuardedPurchase, 'id' | 'nextActionId'>>,
	refused: Map<string, CosignDisposition>,
) {
	for (const purchase of purchases) {
		const disposition = refused.get(purchase.id);
		if (disposition == null) continue;
		await prisma.purchaseRequest.update({
			where: { id: purchase.id },
			data: {
				ActionHistory: { connect: { id: purchase.nextActionId } },
				NextAction: {
					create:
						disposition.kind === 'retry'
							? {
									// errorType stays null: the batch job selects only queued rows without one.
									requestedAction: PurchasingAction.FundsLockingRequested,
									errorType: null,
									errorNote: disposition.note,
								}
							: {
									requestedAction: PurchasingAction.WaitingForManualAction,
									errorType: disposition.policy ? PurchaseErrorType.PolicyDenied : PurchaseErrorType.Unknown,
									errorNote: disposition.note,
								},
				},
			},
		});
	}
}
