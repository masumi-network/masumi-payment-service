import { convertDecimalToBaseUnits } from '@/lib/convertDecimalToBaseUnits';
import {
  getRuleAssetMetaFromPreset,
  type RuleAssetPreset,
} from '@/components/wallets/wallet-details-utils';

export type AssetPolicyInput = {
  preset: RuleAssetPreset;
  customAssetUnit: string;
  warningThreshold: string;
  criticalThreshold: string;
  topupAmount: string;
};

export type AssetPolicyPayload = {
  assetUnit: string;
  warningThreshold: string;
  criticalThreshold: string;
  topupAmount: string;
};

/** Mirrors CONSTANTS.MIN_TOPUP_LOVELACE. ADA only — see below. */
const MIN_TOPUP_ADA = 5;

const isPositiveDecimal = (value: string, decimals: number | null) => {
  const pattern =
    decimals == null || decimals === 0 ? /^\d+$/ : new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`);
  return pattern.test(value.trim()) && Number(value) > 0;
};

/**
 * Validate and convert the operator's rows into the API's per-asset payload.
 *
 * Returns an error string rather than throwing so both forms surface it the
 * same way. Amounts arrive in display units (ADA, USDM) and leave in the
 * asset's smallest unit, because that is what the API stores.
 */
export function buildAssetPolicyPayload(
  rows: AssetPolicyInput[],
  network: 'Preprod' | 'Mainnet',
): { assets: AssetPolicyPayload[] } | { error: string } {
  if (rows.length === 0) return { error: 'Add at least one asset to distribute' };

  const assets: AssetPolicyPayload[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const meta = getRuleAssetMetaFromPreset(row.preset, network, row.customAssetUnit);
    const assetUnit = meta.assetUnit.trim();

    if (!assetUnit) return { error: 'Enter the policy id and asset name for the custom token' };
    if (assetUnit !== 'lovelace' && !/^[0-9a-fA-F]{56}[0-9a-fA-F]*$/.test(assetUnit)) {
      return {
        error: `"${assetUnit}" is not a valid asset unit — expected a policy id followed by the hex asset name`,
      };
    }
    if (seen.has(assetUnit)) return { error: `${meta.label} is listed twice` };
    seen.add(assetUnit);

    for (const [field, value] of [
      ['Warning threshold', row.warningThreshold],
      ['Critical threshold', row.criticalThreshold],
      ['Top-up amount', row.topupAmount],
    ] as const) {
      if (!isPositiveDecimal(value, meta.decimals)) {
        return { error: `${field} for ${meta.label} must be a positive amount` };
      }
    }

    if (Number(row.criticalThreshold) >= Number(row.warningThreshold)) {
      return { error: `Critical threshold for ${meta.label} must be below its warning threshold` };
    }
    // The min-UTxO floor is an ADA constraint: an ADA output below it cannot
    // build. A token quantity has no such bound, so applying the floor to USDM
    // would reject a perfectly sensible 1 USDM top-up.
    if (assetUnit === 'lovelace' && Number(row.topupAmount) < MIN_TOPUP_ADA) {
      return { error: `Top-up amount for ADA must be at least ${MIN_TOPUP_ADA} ADA` };
    }

    const decimals = meta.decimals ?? 0;
    assets.push({
      assetUnit,
      warningThreshold: convertDecimalToBaseUnits(row.warningThreshold, decimals),
      criticalThreshold: convertDecimalToBaseUnits(row.criticalThreshold, decimals),
      topupAmount: convertDecimalToBaseUnits(row.topupAmount, decimals),
    });
  }

  return { assets };
}
