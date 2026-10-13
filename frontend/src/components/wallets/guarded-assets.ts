import { PREPROD_USDM_CONFIG, USDCX_CONFIG, USDM_CONFIG } from '@/lib/constants/defaultWallets';
import { formatDecimalString } from './wallet-details-utils';

type Network = 'Preprod' | 'Mainnet';

export const LOVELACE = 'lovelace';
const POLICY_ID_HEX_LENGTH = 56;
/** Exchain co-signs 6-decimal assets only, and every governable asset has 6. */
export const GOVERNABLE_DECIMALS = 6;

/** An asset a guarded wallet may pay in, in both spellings. */
export type GovernableAsset = {
  /** Exchain `AssetId`: `lovelace` or `<policy>.<nameHex>`. */
  assetId: string;
  /** `lovelace` or `<policy><nameHex>`, as the chain and the limits use it. */
  unit: string;
  label: string;
};

export function assetIdOfUnit(unit: string): string {
  return unit === LOVELACE || unit === ''
    ? LOVELACE
    : `${unit.slice(0, POLICY_ID_HEX_LENGTH)}.${unit.slice(POLICY_ID_HEX_LENGTH)}`;
}

export function unitOfAssetId(assetId: string): string {
  return assetId === LOVELACE ? LOVELACE : assetId.replace('.', '');
}

/** ADA plus the stablecoins the service lets a guarded wallet pay in on `network`. */
export function governableAssets(network: Network): GovernableAsset[] {
  const tokens =
    network === 'Mainnet'
      ? [
          { unit: USDM_CONFIG.fullAssetId, label: 'USDM' },
          { unit: USDCX_CONFIG.fullAssetId, label: 'USDCx' },
        ]
      : [{ unit: PREPROD_USDM_CONFIG.fullAssetId, label: 'tUSDM' }];
  return [
    { assetId: LOVELACE, unit: LOVELACE, label: 'ADA' },
    ...tokens.map((token) => ({ ...token, assetId: assetIdOfUnit(token.unit) })),
  ];
}

function knownAsset(unit: string, network: Network): GovernableAsset | undefined {
  return governableAssets(network).find((asset) => asset.unit === unit);
}

/** Display name of a unit or an Exchain asset id. */
export function assetLabelOf(unitOrAssetId: string, network: Network): string {
  const unit = unitOfAssetId(unitOrAssetId);
  return knownAsset(unit, network)?.label ?? `${unit.slice(0, 8)}…${unit.slice(-6)}`;
}

/** Whole units for a known asset; raw minor units for any other, whose decimals are unknown. */
export function decimalsOf(unit: string, network: Network): number {
  return knownAsset(unit, network) == null ? 0 : GOVERNABLE_DECIMALS;
}

export function formatAssetAmount(quantity: string, unit: string, network: Network): string {
  const decimals = decimalsOf(unit, network);
  const amount = decimals === 0 ? quantity : formatDecimalString(quantity, decimals);
  return `${amount} ${assetLabelOf(unit, network)}${decimals === 0 ? ' (raw)' : ''}`;
}
