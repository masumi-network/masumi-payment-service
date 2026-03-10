import createHttpError from 'http-errors';

export type PaymentWithInvoiceContext = {
	id: string;
	onChainState: string | null;
	unlockTime: bigint;
	blockchainIdentifier: string;
	invoiceBaseId: string | null;
	RequestedFunds: Array<{ unit: string; amount: bigint }>;
	WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
	TransactionHistory: Array<{ txHash: string | null }>;
	BuyerWallet: { walletVkey: string; walletAddress: string } | null;
	SmartContractWallet: { walletVkey: string; walletAddress: string } | null;
};

/**
 * Filter payments to only include final (billable) states:
 * - Withdrawn: seller completed work and withdrew funds → use RequestedFunds
 * - ResultSubmitted where unlockTime <= now: seller can claim imminently → use RequestedFunds
 * - DisputedWithdrawn: partial resolution → use WithdrawnForSeller (skip if empty)
 * Everything else is excluded (RefundWithdrawn, FundsLocked, RefundRequested, Disputed, FundsOrDatumInvalid, null)
 */
export function isPaymentBillable(payment: {
	onChainState: string | null;
	unlockTime: bigint;
	WithdrawnForSeller: Array<{ amount: bigint }>;
	TransactionHistory: Array<{ txHash: string | null }>;
}): boolean {
	const state = payment.onChainState;
	// Require at least one confirmed on-chain transaction to prevent mock data from being invoiced
	const hasOnChainTx = payment.TransactionHistory.some((tx) => tx.txHash != null);
	if (!hasOnChainTx) return false;

	if (state === 'Withdrawn') return true;
	if (state === 'ResultSubmitted' && payment.unlockTime <= BigInt(Date.now())) return true;
	if (state === 'DisputedWithdrawn' && payment.WithdrawnForSeller.length > 0) return true;
	return false;
}

/** Normalize asset unit: "lovelace" → "" (empty string = ADA in MeshSDK convention) */
function normalizeUnit(unit: string): string {
	return unit === 'lovelace' ? '' : unit;
}

export function getBillableFunds(payment: {
	onChainState: string | null;
	RequestedFunds: Array<{ unit: string; amount: bigint }>;
	WithdrawnForSeller: Array<{ unit: string; amount: bigint }>;
}): Array<{ unit: string; amount: bigint }> {
	const funds = payment.onChainState === 'DisputedWithdrawn' ? payment.WithdrawnForSeller : payment.RequestedFunds;
	return funds.map((fund) => ({ unit: normalizeUnit(fund.unit), amount: fund.amount }));
}

export function getSellerWalletVkey(payment: Pick<PaymentWithInvoiceContext, 'id' | 'SmartContractWallet'>): string {
	const sellerWalletVkey = payment.SmartContractWallet?.walletVkey?.trim();
	if (!sellerWalletVkey) {
		throw createHttpError(
			409,
			`Payment ${payment.id} has no seller wallet vkey and cannot be scoped to an invoice base`,
		);
	}
	return sellerWalletVkey;
}

export function collectDistinctSellerWalletVkeys(
	payments: ReadonlyArray<Pick<PaymentWithInvoiceContext, 'id' | 'SmartContractWallet'>>,
): string[] {
	return Array.from(new Set(payments.map((payment) => getSellerWalletVkey(payment))));
}
