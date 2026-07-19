import { getRuleAssetMeta, formatDecimalString } from './wallet-details-utils';
import { convertBaseUnitsToDecimal } from '@/lib/convertDecimalToBaseUnits';
import formatBalance from '@/lib/formatBalance';

type TransferAsset = { unit: string; quantity: string };
type Net = 'Preprod' | 'Mainnet';

/**
 * Lovelace (base units) → grouped ADA display, e.g. "1,250.5". Reuses the same
 * base-unit conversion and thousands grouping the rest of the wallet UI uses.
 */
export function formatAda(lovelace: string): string {
  return formatBalance(convertBaseUnitsToDecimal(lovelace, 6));
}

/**
 * A stored transfer asset → human line, e.g. "10 USDM". Resolves the unit's
 * symbol and decimals through the shared asset-meta table so known stablecoins
 * read in display units; a custom token (unknown decimals) shows its raw
 * on-chain quantity and decoded/shortened name.
 */
export function formatAssetAmount(asset: TransferAsset, network: Net): string {
  const meta = getRuleAssetMeta(asset.unit, network);
  const amount =
    meta.decimals != null
      ? formatBalance(formatDecimalString(asset.quantity, meta.decimals))
      : asset.quantity;
  return `${amount} ${meta.label}`;
}
