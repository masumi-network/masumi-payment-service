/**
 * A Cardano native-asset unit is a 28-byte policy id followed by an asset name
 * of at most 32 bytes. Both parts are hex encoded, so the suffix must contain an
 * even number of characters.
 */
export const CARDANO_NATIVE_ASSET_UNIT_PATTERN = /^[0-9a-fA-F]{56}(?:[0-9a-fA-F]{2}){0,32}$/;

export function isCardanoNativeAssetUnit(assetUnit: string): boolean {
	return CARDANO_NATIVE_ASSET_UNIT_PATTERN.test(assetUnit);
}
