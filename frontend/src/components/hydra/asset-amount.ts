import { PREPROD_USDM_CONFIG, USDM_CONFIG, USDCX_CONFIG } from '../../lib/constants/defaultWallets';
import {
  convertBaseUnitsToDecimal,
  convertDecimalToBaseUnits,
  isValidDecimalAmount,
} from '../../lib/convertDecimalToBaseUnits';

const SIX_DECIMAL_ASSETS = new Set([
  '',
  'lovelace',
  USDM_CONFIG.fullAssetId,
  PREPROD_USDM_CONFIG.fullAssetId,
  USDCX_CONFIG.fullAssetId,
]);

export function hydraAssetDecimals(unit: string): number {
  return SIX_DECIMAL_ASSETS.has(unit.toLowerCase()) ? 6 : 0;
}

/** Unknown assets use raw integer quantities until their decimals are known. */
export function parseHydraAssetAmount(value: string, unit: string): string | null {
  const decimals = hydraAssetDecimals(unit);
  const trimmed = value.trim();
  if (decimals === 0 && !/^\d+$/.test(trimmed)) return null;
  if (!isValidDecimalAmount(trimmed, { decimals })) return null;
  const quantity = convertDecimalToBaseUnits(trimmed, decimals);
  return BigInt(quantity) > BigInt(0) ? quantity : null;
}

/** Return an exact ADA form value for a failed top-up with a recorded amount. */
export function retryTopupAdaAmount(committedLovelace: string | null | undefined): string | null {
  if (committedLovelace == null || !/^\d+$/.test(committedLovelace)) return null;
  if (BigInt(committedLovelace) <= BigInt(0)) return null;
  return convertBaseUnitsToDecimal(committedLovelace);
}
