import createHttpError from 'http-errors';
import { DisputedRequestKind } from './lookup';

export function assertDisclosureReadWalletInScope(
	walletScopeIds: string[] | null,
	params: {
		kind: DisputedRequestKind;
		smartContractWalletId: string | null;
		sellerHotWalletId: string | null;
	},
): void {
	if (walletScopeIds === null) {
		return;
	}
	const allowedIds =
		params.kind === 'purchase'
			? [params.smartContractWalletId, params.sellerHotWalletId]
			: [params.smartContractWalletId];
	const isAllowed = allowedIds.some((id) => id != null && walletScopeIds.includes(id));
	if (!isAllowed) {
		throw createHttpError(404, 'Not found');
	}
}
