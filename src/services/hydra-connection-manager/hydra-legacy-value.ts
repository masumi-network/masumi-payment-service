import { AssetName } from '@emurgo/cardano-serialization-lib-nodejs';
import { canonicalizeHydraAmounts, hydraAmountListsEqual, type HydraAmount } from './hydra-transaction-evidence';

const POLICY_ID_HEX_LENGTH = 56;
const MAX_ASSET_NAME_HEX_LENGTH = 64;

/** Match the complete value written by the former CBOR-prefixed asset-name decoder. */
export function hasLegacyHydraAssetNames(
	persisted: readonly HydraAmount[],
	confirmed: readonly HydraAmount[],
): boolean {
	const canonicalConfirmed = canonicalizeHydraAmounts(confirmed);
	if (!canonicalConfirmed?.length || hydraAmountListsEqual(persisted, canonicalConfirmed)) return false;
	const legacy: HydraAmount[] = [];
	let hasNativeAsset = false;
	for (const amount of canonicalConfirmed) {
		if (amount.unit === 'lovelace') {
			legacy.push(amount);
			continue;
		}
		if (
			!/^[0-9a-f]+$/.test(amount.unit) ||
			amount.unit.length % 2 !== 0 ||
			amount.unit.length < POLICY_ID_HEX_LENGTH ||
			amount.unit.length > POLICY_ID_HEX_LENGTH + MAX_ASSET_NAME_HEX_LENGTH
		) {
			return false;
		}
		const policy = amount.unit.slice(0, POLICY_ID_HEX_LENGTH);
		const name = AssetName.new(Buffer.from(amount.unit.slice(POLICY_ID_HEX_LENGTH), 'hex'));
		legacy.push({ unit: policy + name.to_hex(), quantity: amount.quantity });
		name.free();
		hasNativeAsset = true;
	}
	return hasNativeAsset && hydraAmountListsEqual(persisted, legacy);
}
