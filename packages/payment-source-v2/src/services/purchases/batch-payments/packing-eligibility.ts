import type { GuardedWallet } from '@/generated/prisma/client';
import { guardedPurchaseFits } from './guarded-packing';
import { isHotWalletEligibleForL2Lock } from './l2-lock-helpers';

/**
 * Whether a lock pass (L1 packing or L2 routing) may put `request` on this
 * wallet at all, before any balance is compared: a purchase limited to other
 * hot wallets never may, and a guarded wallet only takes purchases priced in
 * the one asset it pays in.
 */
export function isPackableForWallet(
	request: {
		isLimitedToHotWallets: boolean;
		HotWalletLimit: ReadonlyArray<{ id: string }>;
		PaidFunds: Array<{ unit: string }>;
	},
	wallet: { walletId: string; guarded: Pick<GuardedWallet, 'governedAsset'> | null },
): boolean {
	if (!isHotWalletEligibleForL2Lock(request, wallet.walletId)) return false;
	return wallet.guarded == null || guardedPurchaseFits(wallet.guarded.governedAsset, request.PaidFunds);
}
