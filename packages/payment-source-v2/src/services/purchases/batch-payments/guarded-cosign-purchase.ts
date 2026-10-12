import { PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { decodeBlockchainIdentifier } from '@masumi/payment-core/blockchain-identifier';
import { jobHashOf, type CosignIntent } from '../../../smart-wallet/cosign-client';
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

/** A guarded wallet governs lovelace only, so packing never hands it a purchase with native tokens. */
export function guardedLockLovelace(purchase: Pick<GuardedPurchase, 'id' | 'PaidFunds'>): bigint {
	let lovelace = 0n;
	for (const funds of purchase.PaidFunds) {
		if (funds.unit !== '' && funds.unit !== 'lovelace') {
			throw new Error(`guarded wallets lock lovelace only; purchase ${purchase.id} carries ${funds.unit}`);
		}
		lovelace += funds.amount;
	}
	return lovelace;
}

/** `amountLovelace` is the escrow output's lovelace, which is what the co-signer checks the body against. */
export function cosignIntentFor(purchase: GuardedPurchase, outputIndex: number, amountLovelace: bigint): CosignIntent {
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
		amount: amountLovelace.toString(),
		asset: 'lovelace',
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
