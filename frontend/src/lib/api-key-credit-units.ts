import {
  getUsdmConfig,
  USDCX_CONFIG,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';
import { assetPresetsForNetwork, type AssetPresetNetwork } from '@/lib/x402-registration';

/**
 * The unit an ADA credit row must carry.
 *
 * NOT 'lovelace'. The purchase path runs every requested unit through
 * `normalizePurchaseUnit` (src/utils/shared/transformers.ts), which maps
 * 'lovelace' to '' before the cost reaches the credit gate. The gate compares
 * those units against `RemainingUsageCredits` verbatim, so a row stored as
 * 'lovelace' can never match an ADA purchase and the key fails with
 * `Credit unit not found:` for a balance the dashboard shows as funded.
 */
export const ADA_CREDIT_UNIT = '';

/** Cardano native assets and the EVM stablecoins in EVM_ASSET_PRESETS are all 6dp. */
export const DEFAULT_CREDIT_DECIMALS = 6;

export type CardanoNetwork = 'Mainnet' | 'Preprod';

export interface CreditUnitOption {
  /** Exact string written to `UsageCreditsToAddOrRemove[].unit`. */
  unit: string;
  /** Short name for the amount field, e.g. 'ADA' or 'USDC'. */
  label: string;
  /** Where the unit spends, e.g. 'Cardano Mainnet' or 'Base Mainnet'. */
  group: string;
  /** Full identifier, shown under the label so two same-symbol assets stay distinguishable. */
  identifier: string;
  decimals: number;
}

function cardanoOptions(network: CardanoNetwork): CreditUnitOption[] {
  const group = `Cardano ${network}`;
  const usdm = getUsdmConfig(network);
  const options: CreditUnitOption[] = [
    {
      unit: ADA_CREDIT_UNIT,
      label: 'ADA',
      group,
      identifier: 'lovelace',
      decimals: DEFAULT_CREDIT_DECIMALS,
    },
    {
      unit: usdm.fullAssetId,
      label: network === 'Mainnet' ? 'USDM' : 'tUSDM',
      group,
      identifier: usdm.fullAssetId,
      decimals: DEFAULT_CREDIT_DECIMALS,
    },
  ];
  if (network === 'Mainnet') {
    options.push({
      unit: USDCX_CONFIG.fullAssetId,
      label: getActiveStablecoinSymbol(network),
      group,
      identifier: USDCX_CONFIG.fullAssetId,
      decimals: DEFAULT_CREDIT_DECIMALS,
    });
  }
  return options;
}

function evmOptions(caip2Id: string, networks: AssetPresetNetwork[]): CreditUnitOption[] {
  const network = networks.find((candidate) => candidate.caip2Id === caip2Id);
  if (!network) return [];
  return assetPresetsForNetwork(network).map((preset) => ({
    // The x402 debit lowercases the asset address, and the API rejects any other
    // shape outright (findNonCanonicalEvmCreditUnit), so build the canonical form here.
    unit: `${caip2Id}:${preset.address.toLowerCase()}`,
    label: preset.symbol,
    group: network.displayName,
    identifier: `${caip2Id}:${preset.address.toLowerCase()}`,
    decimals: preset.decimals,
  }));
}

/**
 * The credit units a given API key can actually spend, derived from that key's own
 * access list rather than from a fixed pair of fields.
 *
 * The dialog used to offer exactly ADA and the active stablecoin, so a key that pays
 * in USDM on Mainnet (where the active stablecoin is USDCx) could not be funded for
 * the asset it spends, and an EVM key could not be funded at all. Every unit the key
 * already holds a row for is included too, even an unrecognised or stale one, so a
 * balance is never invisible in the UI that is supposed to manage it.
 */
export function creditUnitOptionsForKey({
  networkLimit,
  chainIdLimit,
  evmNetworks,
  existingUnits = [],
}: {
  networkLimit: CardanoNetwork[];
  chainIdLimit: string[];
  evmNetworks: AssetPresetNetwork[];
  existingUnits?: string[];
}): CreditUnitOption[] {
  const options: CreditUnitOption[] = [];
  for (const network of ['Mainnet', 'Preprod'] as const) {
    if (networkLimit.includes(network)) options.push(...cardanoOptions(network));
  }
  for (const caip2Id of chainIdLimit.filter((chainId) => chainId.startsWith('eip155:'))) {
    options.push(...evmOptions(caip2Id, evmNetworks));
  }

  const known = new Set(options.map((option) => option.unit));
  for (const unit of existingUnits) {
    if (known.has(unit)) continue;
    known.add(unit);
    options.push({
      unit,
      label: unit === ADA_CREDIT_UNIT ? 'ADA' : shortenCreditUnit(unit),
      group: 'Already on this key',
      identifier: unit === ADA_CREDIT_UNIT ? 'lovelace' : unit,
      decimals: DEFAULT_CREDIT_DECIMALS,
    });
  }
  return options;
}

/**
 * Sum the ledger's rows per unit.
 *
 * `GET /api-key` returns `RemainingUsageCredits` verbatim, and the node can hold more
 * than one row for the same unit: `runPurchaseCreditInitTransaction` collapses
 * duplicates when it debits, which is only necessary because they occur. Two rows for
 * one unit would otherwise become two editable fields sharing a React key, two deltas
 * both diffed against a single row's balance, and a "currently" hint that reads only
 * one of them.
 */
export function consolidateCreditRows(
  rows: Array<{ unit: string; amount: string }>,
): Array<{ unit: string; amount: string }> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    totals.set(row.unit, (totals.get(row.unit) ?? BigInt(0)) + BigInt(row.amount));
  }
  return Array.from(totals, ([unit, amount]) => ({ unit, amount: amount.toString() }));
}

/** Middle-elide a policy id or chain-qualified address so it fits a label. */
export function shortenCreditUnit(unit: string): string {
  if (unit.length <= 20) return unit;
  return `${unit.slice(0, 10)}…${unit.slice(-6)}`;
}

/**
 * Turn edited balances into the deltas PATCH expects.
 *
 * `UsageCreditsToAddOrRemove` is a delta list, not a set of absolute balances, so an
 * operator typing a new balance means "move it by this much". Units whose balance is
 * unchanged are omitted entirely; sending a zero delta for an absent unit is a 400
 * ('Invalid amount') on the server.
 *
 * A unit dropped from `next` is zeroed rather than ignored, because otherwise removing a
 * row in the UI left the stored balance untouched and the form lied about what it saved.
 * The server keeps a zeroed row on purpose: it is the record that the key is capped on
 * that unit, and deleting it would read as "never capped" to the x402 enforcement probe.
 */
export function creditDeltas(
  current: Array<{ unit: string; amount: string }>,
  next: Array<{ unit: string; amount: string }>,
): Array<{ unit: string; amount: string }> {
  const currentByUnit = new Map(current.map((row) => [row.unit, BigInt(row.amount)]));
  const nextUnits = new Set(next.map((row) => row.unit));
  const deltas: Array<{ unit: string; amount: string }> = [];
  for (const row of next) {
    const delta = BigInt(row.amount) - (currentByUnit.get(row.unit) ?? BigInt(0));
    if (delta !== BigInt(0)) deltas.push({ unit: row.unit, amount: delta.toString() });
  }
  for (const [unit, amount] of currentByUnit) {
    if (nextUnits.has(unit) || amount === BigInt(0)) continue;
    deltas.push({ unit, amount: (-amount).toString() });
  }
  return deltas;
}
