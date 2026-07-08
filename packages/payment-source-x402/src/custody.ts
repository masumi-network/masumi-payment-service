import createHttpError from 'http-errors';

/** null = admin / unrestricted; string = only wallets created by that API key. */
export type X402WalletCustodyScope = string | null;

export function buildX402WalletCustodyWhere(custodyScope: X402WalletCustodyScope) {
	if (custodyScope === null) return {};
	return { createdById: custodyScope };
}

export function assertX402WalletCustody(
	custodyScope: X402WalletCustodyScope,
	wallet: { createdById: string | null },
): void {
	if (custodyScope === null) return;
	if (wallet.createdById !== custodyScope) {
		throw createHttpError(404, 'Managed EVM wallet not found');
	}
}
