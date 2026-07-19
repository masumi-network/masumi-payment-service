import { shortenAddress, hexToAscii } from '@/lib/utils';
import formatBalance from '@/lib/formatBalance';
import { getUsdmConfig, USDCX_CONFIG } from '@/lib/constants/defaultWallets';
import type { DisplayWalletType } from '@/lib/wallet-type';

export interface TokenBalance {
  unit: string;
  policyId: string;
  assetName: string;
  // BigInt: on-chain token quantities (whale ADA, high-supply native tokens)
  // routinely exceed 2^53, so a Number here would silently lose precision.
  quantity: bigint;
}

export type LowBalanceSummary = {
  isLow: boolean;
  lowRuleCount: number;
  lastCheckedAt: Date | null;
};

export type LowBalanceRule = {
  id: string;
  assetUnit: string;
  thresholdAmount: string;
  enabled: boolean;
  // Auto top-up: when topupEnabled, a fund wallet on the source sends topupAmount
  // (raw on-chain units) each time this rule's balance drops below threshold.
  topupEnabled: boolean;
  topupAmount: string | null;
  status: 'Unknown' | 'Healthy' | 'Low';
  lastKnownAmount: string | null;
  lastCheckedAt: Date | null;
  lastAlertedAt: Date | null;
};

export type WalletDetailsState = {
  LowBalanceSummary: LowBalanceSummary;
  LowBalanceRules: LowBalanceRule[];
};

export type RuleDraft = {
  thresholdInput: string;
  enabled: boolean;
  // Auto top-up: when enabled, a fund wallet on the source tops this wallet up by
  // topupAmountInput (display units) whenever the balance drops below threshold.
  topupEnabled: boolean;
  topupAmountInput: string;
};

export type RuleAssetPreset = 'lovelace' | 'stablecoin' | 'custom';

export type RuleAssetMeta = {
  assetUnit: string;
  label: string;
  decimals: number | null;
  inputLabel: string;
  helperText: string;
};

export interface WalletWithBalance {
  id: string;
  walletVkey: string;
  walletAddress: string;
  collectionAddress: string | null;
  note: string | null;
  type: DisplayWalletType;
  balance: string;
  usdcxBalance: string;
  /** True when the balance fetch failed — render "unknown", not 0. */
  isBalanceUnavailable?: boolean;
  LowBalanceSummary?: LowBalanceSummary;
}

export const EMPTY_LOW_BALANCE_SUMMARY: LowBalanceSummary = {
  isLow: false,
  lowRuleCount: 0,
  lastCheckedAt: null,
};

export const SUPPORTED_RULE_DECIMALS = 6;
export const CARDANO_POLICY_ID_HEX_LENGTH = 56;
export const MIN_TOPUP_LOVELACE = BigInt(5_000_000);
export const CARDANO_NATIVE_ASSET_UNIT_PATTERN = /^[0-9a-fA-F]{56}(?:[0-9a-fA-F]{2}){0,32}$/;

export function getAssetUnitBreakdown(assetUnit: string) {
  const normalized = assetUnit.trim();
  const policyId = normalized.slice(0, CARDANO_POLICY_ID_HEX_LENGTH);
  const assetNameHex = normalized.slice(CARDANO_POLICY_ID_HEX_LENGTH);
  const decodedAssetName = assetNameHex ? hexToAscii(assetNameHex) : '';

  return {
    policyId,
    assetNameHex,
    decodedAssetName,
  };
}

export function getStablecoinRuleMeta(network: 'Preprod' | 'Mainnet'): RuleAssetMeta {
  const stablecoin = network === 'Mainnet' ? USDCX_CONFIG : getUsdmConfig(network);

  return {
    assetUnit: stablecoin.fullAssetId,
    label: network === 'Mainnet' ? 'USDCx' : 'tUSDM',
    decimals: SUPPORTED_RULE_DECIMALS,
    inputLabel: `Threshold (${network === 'Mainnet' ? 'USDCx' : 'tUSDM'})`,
    helperText: 'Stored on-chain with 6 decimals.',
  };
}

export function getRuleAssetMeta(assetUnit: string, network: 'Preprod' | 'Mainnet'): RuleAssetMeta {
  if (assetUnit === 'lovelace') {
    return {
      assetUnit: 'lovelace',
      label: 'ADA',
      decimals: SUPPORTED_RULE_DECIMALS,
      inputLabel: 'Threshold (ADA)',
      helperText: 'Stored on-chain as lovelace with 6 decimals.',
    };
  }

  const stablecoin = getStablecoinRuleMeta(network);
  if (assetUnit === stablecoin.assetUnit) {
    return stablecoin;
  }

  const assetName = hexToAscii(assetUnit.slice(CARDANO_POLICY_ID_HEX_LENGTH));

  return {
    assetUnit,
    label: assetName || shortenAddress(assetUnit, 8),
    decimals: null,
    inputLabel: 'Threshold (raw units)',
    helperText: 'Custom assets are configured in raw on-chain quantity.',
  };
}

export function getRuleAssetMetaFromPreset(
  preset: RuleAssetPreset,
  network: 'Preprod' | 'Mainnet',
  customAssetUnit: string,
): RuleAssetMeta {
  if (preset === 'lovelace') {
    return getRuleAssetMeta('lovelace', network);
  }

  if (preset === 'stablecoin') {
    return getStablecoinRuleMeta(network);
  }

  return getRuleAssetMeta(customAssetUnit.trim(), network);
}

export function formatDecimalString(rawAmount: string, decimals: number) {
  const normalized = rawAmount.replace(/^0+(?=\d)/, '') || '0';
  const padded = normalized.padStart(decimals + 1, '0');
  const whole = padded.slice(0, -decimals).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-decimals).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

export function parseDecimalToRawAmount(displayAmount: string, decimals: number) {
  const normalized = displayAmount.trim();

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  const [wholePart, fractionalPart = ''] = normalized.split('.');
  if (fractionalPart.length > decimals) {
    return null;
  }

  const combined = `${wholePart}${fractionalPart.padEnd(decimals, '0')}`;
  return combined.replace(/^0+(?=\d)/, '') || '0';
}

export function getThresholdInputFromRaw(
  rawAmount: string,
  assetUnit: string,
  network: 'Preprod' | 'Mainnet',
) {
  const assetMeta = getRuleAssetMeta(assetUnit, network);

  if (assetMeta.decimals == null) {
    return rawAmount;
  }

  return formatDecimalString(rawAmount, assetMeta.decimals);
}

export function parseThresholdInputToRaw(
  thresholdInput: string,
  assetUnit: string,
  network: 'Preprod' | 'Mainnet',
) {
  const assetMeta = getRuleAssetMeta(assetUnit, network);

  if (assetMeta.decimals == null) {
    const normalized = thresholdInput.trim();
    return /^\d+$/.test(normalized) ? normalized : null;
  }

  return parseDecimalToRawAmount(thresholdInput, assetMeta.decimals);
}

export function validateRuleTopupInput({
  enabled,
  topupAmountInput,
  assetUnit,
  network,
}: {
  enabled: boolean;
  topupAmountInput: string;
  assetUnit: string;
  network: 'Preprod' | 'Mainnet';
}): {
  rawTopupAmount: string | null;
  error: string | null;
} {
  if (!enabled) {
    return { rawTopupAmount: null, error: null };
  }

  const rawTopupAmount = parseThresholdInputToRaw(topupAmountInput, assetUnit, network);
  if (rawTopupAmount == null || rawTopupAmount === '0') {
    return {
      rawTopupAmount,
      error: 'Enter a top-up amount greater than zero, or turn auto top-up off.',
    };
  }

  if (assetUnit === 'lovelace' && BigInt(rawTopupAmount) < MIN_TOPUP_LOVELACE) {
    return {
      rawTopupAmount,
      error: 'ADA top-up amount must be at least 5 ADA.',
    };
  }

  if (assetUnit !== 'lovelace' && !CARDANO_NATIVE_ASSET_UNIT_PATTERN.test(assetUnit)) {
    return {
      rawTopupAmount,
      error:
        'Auto top-up needs a valid Cardano asset unit: policy id followed by an asset name of at most 32 bytes.',
    };
  }

  return { rawTopupAmount, error: null };
}

export function formatRuleAmount(
  amount: string | null,
  assetUnit: string,
  network: 'Preprod' | 'Mainnet',
) {
  if (amount == null) {
    return 'Unknown';
  }

  const assetMeta = getRuleAssetMeta(assetUnit, network);

  if (assetMeta.decimals != null) {
    return `${formatBalance(formatDecimalString(amount, assetMeta.decimals))} ${assetMeta.label}`;
  }

  return `${formatBalance(amount)} raw`;
}

export function getRuleAssetLabel(assetUnit: string, network: 'Preprod' | 'Mainnet') {
  return getRuleAssetMeta(assetUnit, network).label;
}

export function getDeleteRuleDialogDescription(
  rule: LowBalanceRule,
  network: 'Preprod' | 'Mainnet',
) {
  const assetMeta = getRuleAssetMeta(rule.assetUnit, network);
  const lines = [
    `Remove the low-balance rule for ${assetMeta.label}?`,
    'This stops interval checks and submission-time warnings for this asset until you add the rule again.',
  ];

  if (assetMeta.decimals == null) {
    lines.push(`Asset unit: ${rule.assetUnit}`);
  }

  return lines.join('\n\n');
}
