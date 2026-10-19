import { assertWalletInScope } from '@/utils/shared/wallet-scope';
import { DisputedRequestRow } from './lookup';

export function assertDisclosureInputWalletInScope(walletScopeIds: string[] | null, target: DisputedRequestRow): void {
	assertWalletInScope(walletScopeIds, target.smartContractWalletId);
}

export function assertDisclosureResultWalletInScope(walletScopeIds: string[] | null, target: DisputedRequestRow): void {
	if (target.kind === 'purchase') {
		assertWalletInScope(walletScopeIds, target.sellerHotWalletId);
		return;
	}
	assertWalletInScope(walletScopeIds, target.smartContractWalletId);
}
