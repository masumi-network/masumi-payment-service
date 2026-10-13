import { MAINNET_USDCX_UNIT, MAINNET_USDM_UNIT, PREPROD_USDM_UNIT } from '@/utils/asset-units';

/**
 * The one asset a guarded wallet pays in. Exchain governs exactly one asset per
 * registered wallet (`WalletRegistration.governedAsset`), so agents pay sellers
 * in that asset only; the wallet may still hold and move others.
 *
 * Stored and sent in Exchain's `AssetId` form: `lovelace` or `<policy>.<nameHex>`.
 * Packing, PaidFunds and Mesh use the concatenated unit instead; convert with
 * `assetUnitOf` and `exchainAssetIdOf`, never by hand.
 */
export const LOVELACE_ASSET_ID = 'lovelace';

const POLICY_HEX_LENGTH = 56;

/** Concatenated unit (`''`, `lovelace` or `<policy><nameHex>`) to Exchain's `AssetId`. */
export function exchainAssetIdOf(unit: string): string {
	if (unit === '' || unit === LOVELACE_ASSET_ID) return LOVELACE_ASSET_ID;
	return `${unit.slice(0, POLICY_HEX_LENGTH)}.${unit.slice(POLICY_HEX_LENGTH)}`;
}

/** Exchain's `AssetId` to the concatenated unit Mesh uses (`lovelace` for ADA). */
export function assetUnitOf(assetId: string): string {
	return assetId === LOVELACE_ASSET_ID ? LOVELACE_ASSET_ID : assetId.replace('.', '');
}

/** ADA and the 6-decimal stablecoins Exchain can govern on `network`. Preprod has no USDCx. */
export function governableAssetIds(network: 'preprod' | 'mainnet'): string[] {
	const units = network === 'mainnet' ? [MAINNET_USDM_UNIT, MAINNET_USDCX_UNIT] : [PREPROD_USDM_UNIT];
	return [LOVELACE_ASSET_ID, ...units.map(exchainAssetIdOf)];
}

/** The on-chain period limit of `assetId` among a wallet's assets, or null when the datum does not list it. */
export function governedLimitOf(assets: Array<{ unit: string; limit: bigint | null }>, assetId: string): bigint | null {
	return assets.find((asset) => exchainAssetIdOf(asset.unit) === assetId)?.limit ?? null;
}
