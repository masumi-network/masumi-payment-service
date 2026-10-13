import type { GuardedWalletState } from '@masumi/payment-source-v2/smart-wallet/guarded-wallet';

/** The per-asset view the guarded wallet endpoints return: bigints as strings. */
export function assetsView(state: Pick<GuardedWalletState, 'assets'>) {
	return state.assets.map((asset) => ({
		unit: asset.unit,
		quantity: asset.quantity.toString(),
		limit: asset.limit?.toString() ?? null,
		spentInPeriod: asset.spentInPeriod?.toString() ?? null,
	}));
}
