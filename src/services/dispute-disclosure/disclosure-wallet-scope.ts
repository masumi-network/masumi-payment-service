import createHttpError from 'http-errors';
import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import { DisputedRequestRow } from './lookup';

export function assertDisclosureInputWalletInScope(
	walletScopeIds: string[] | null,
	target: DisputedRequestRow,
	requesterId?: string,
): void {
	if (target.kind === 'purchase') {
		if (walletScopeIds === null) {
			return;
		}
		if (requesterId != null && target.requestedById === requesterId) {
			return;
		}
		const allowedIds = [target.smartContractWalletId, target.sellerHotWalletId];
		if (!allowedIds.some((id) => id != null && walletScopeIds.includes(id))) {
			throw createHttpError(404, 'Not found');
		}
		return;
	}
	assertWalletInScope(walletScopeIds, target.smartContractWalletId);
}

export function assertDisclosureResultWalletInScope(walletScopeIds: string[] | null, target: DisputedRequestRow): void {
	if (target.kind === 'purchase') {
		assertWalletInScope(walletScopeIds, target.sellerHotWalletId);
		return;
	}
	assertWalletInScope(walletScopeIds, target.smartContractWalletId);
}
