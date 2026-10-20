import createHttpError from 'http-errors';
import { DisputedRequestKind } from './lookup';

export function isDisclosureReadWalletInScope(
	walletScopeIds: string[] | null,
	params: {
		kind: DisputedRequestKind;
		smartContractWalletId: string | null;
		sellerHotWalletId: string | null;
	},
): boolean {
	if (walletScopeIds === null) {
		return true;
	}
	const allowedIds =
		params.kind === 'purchase'
			? [params.smartContractWalletId, params.sellerHotWalletId]
			: [params.smartContractWalletId];
	return allowedIds.some((id) => id != null && walletScopeIds.includes(id));
}

export function assertDisclosureReadWalletInScope(
	walletScopeIds: string[] | null,
	params: {
		kind: DisputedRequestKind;
		smartContractWalletId: string | null;
		sellerHotWalletId: string | null;
		canAdmin?: boolean;
	},
): void {
	if (params.canAdmin === true || walletScopeIds === null) {
		return;
	}
	if (!isDisclosureReadWalletInScope(walletScopeIds, params)) {
		throw createHttpError(404, 'Not found');
	}
}
