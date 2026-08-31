import {
  getUsdmConfig,
  USDCX_CONFIG,
  getActiveStablecoinSymbol,
} from '@/lib/constants/defaultWallets';
import { assetPresetsForNetwork, type AssetPresetNetwork } from '@/lib/x402-registration';
import { convertDecimalToBaseUnits, isValidDecimalAmount } from '@/lib/convertDecimalToBaseUnits';
import { POSTGRES_BIGINT_MAX } from '@/lib/registry-validation';

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

/** Group for units read back off a key's ledger that no preset describes. */
export const UNKNOWN_GROUP_ID = 'unknown';

/**
 * The chain a group of units settles on, carried so a custom asset typed into that
 * group can be validated and chain-qualified without the field guessing from the
 * group's display name. 'unknown' marks units recovered from the key's own ledger:
 * a stored string alone does not say which chain issued it.
 */
export type CreditChain =
  | { kind: 'cardano'; network: CardanoNetwork }
  | { kind: 'evm'; caip2Id: string }
  | { kind: 'unknown' };

export interface CreditUnitOption {
  /** Exact string written to `UsageCreditsToAddOrRemove[].unit`. */
  unit: string;
  /** Short name for the amount field, e.g. 'ADA' or 'USDC'. */
  label: string;
  /**
   * Stable key for the unit's chain. NOT the display name: X402Network.displayName is
   * free text and only caip2Id is unique, so two chains named "Base" would otherwise
   * merge into one picker group and one custom-asset entry, which would then qualify
   * the asset for whichever chain happened to be first.
   */
  groupId: string;
  /** Where the unit spends, e.g. 'Cardano Mainnet' or 'Base Mainnet'. */
  group: string;
  /** Full identifier, shown under the label so two same-symbol assets stay distinguishable. */
  identifier: string;
  decimals: number;
  chain: CreditChain;
}

function cardanoOptions(network: CardanoNetwork): CreditUnitOption[] {
  const group = `Cardano ${network}`;
  const groupId = `cardano:${network.toLowerCase()}`;
  const chain: CreditChain = { kind: 'cardano', network };
  const usdm = getUsdmConfig(network);
  const options: CreditUnitOption[] = [
    {
      unit: ADA_CREDIT_UNIT,
      label: 'ADA',
      groupId,
      group,
      identifier: 'lovelace',
      decimals: DEFAULT_CREDIT_DECIMALS,
      chain,
    },
    {
      unit: usdm.fullAssetId,
      label: network === 'Mainnet' ? 'USDM' : 'tUSDM',
      groupId,
      group,
      identifier: usdm.fullAssetId,
      decimals: DEFAULT_CREDIT_DECIMALS,
      chain,
    },
  ];
  if (network === 'Mainnet') {
    options.push({
      unit: USDCX_CONFIG.fullAssetId,
      label: getActiveStablecoinSymbol(network),
      groupId,
      group,
      identifier: USDCX_CONFIG.fullAssetId,
      decimals: DEFAULT_CREDIT_DECIMALS,
      chain,
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
    groupId: caip2Id,
    group: network.displayName,
    identifier: `${caip2Id}:${preset.address.toLowerCase()}`,
    decimals: preset.decimals,
    chain: { kind: 'evm', caip2Id },
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
      groupId: UNKNOWN_GROUP_ID,
      group: 'Already on this key',
      identifier: unit === ADA_CREDIT_UNIT ? 'lovelace' : unit,
      // Nothing here says how many decimals this asset uses, and PATCH carries only
      // unit and amount, so a decimals guess cannot survive a reopen either. Base
      // units round-trip exactly instead.
      decimals: 0,
      chain: { kind: 'unknown' },
    });
  }
  return options;
}

/** The chain-qualified EVM credit unit the debit path stores, always lowercase. */
const EVM_CREDIT_UNIT = /^eip155:\d+:0x[0-9a-fA-F]{40}$/;

/**
 * The unit a stored row is really about, matching `normalizeCreditUnit` on the server
 * (src/routes/api/api-key/credit-units.ts).
 *
 * The dialog has to group rows the way PATCH resolves them, or the two disagree about
 * what a row IS. 'lovelace' and '' are one asset to the server, and it rewrites the
 * unit it stores, so showing them as two rows offered an edit the API cannot express:
 * a delta for either one is normalized to '' and applied to the ADA balance. Removing
 * the legacy row then drained the live one. EVM units differ only in address case for
 * the same reason.
 *
 * Cardano native assets are NOT touched: asset-name hex is case-significant there and
 * the credit gate matches it byte for byte.
 */
export function normalizeCreditUnit(unit: string): string {
  if (unit.toLowerCase() === 'lovelace') return ADA_CREDIT_UNIT;
  return EVM_CREDIT_UNIT.test(unit) ? unit.toLowerCase() : unit;
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
 *
 * Grouped on the NORMALIZED unit, because that is what PATCH folds a delta onto. A
 * legacy 'lovelace' row grouped on its own read as a second asset the operator could
 * edit or remove separately, and neither edit meant what it looked like.
 */
export function consolidateCreditRows(
  rows: Array<{ unit: string; amount: string }>,
): Array<{ unit: string; amount: string }> {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    const unit = normalizeCreditUnit(row.unit);
    totals.set(unit, (totals.get(unit) ?? BigInt(0)) + BigInt(row.amount));
  }
  return Array.from(totals, ([unit, amount]) => ({ unit, amount: amount.toString() }));
}

/**
 * A Cardano native asset unit: a 28-byte policy id followed by an asset name of up
 * to 32 bytes, both hex, concatenated exactly as the ledger stores them.
 */
const CARDANO_ASSET_UNIT = /^[0-9a-f]{56}(?:[0-9a-f]{2}){0,32}$/;

/** A bare ERC-20 contract address, before it is chain-qualified. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** `UsageCreditsToAddOrRemove[].unit` is `z.string().max(150)` on both routes. */
const MAX_CREDIT_UNIT_LENGTH = 150;

/**
 * Turn an operator-typed asset id into the exact unit string the debit path looks up,
 * or explain why it cannot be one.
 *
 * The preset lists only cover the assets this repo ships constants for, so a key that
 * pays in any other token could not be funded at all from the dialog. Accepting free
 * text needs the same canonical shape the server enforces, because a near miss is not
 * a cosmetic problem: `findNonCanonicalEvmCreditUnit` rejects EVM-ish units outright,
 * and a Cardano unit that does not match what the purchase path requests is stored
 * happily and then fails every payment with `Credit unit not found`.
 *
 * EVM input may be a bare address or an already-qualified `eip155:<id>:0x…` unit; a
 * qualified one must name the chain it was typed under, so an address pasted into the
 * wrong group is refused instead of silently re-homed.
 */
export function buildCustomCreditUnit(
  chain: CreditChain,
  raw: string,
): { unit: string } | { error: string } {
  const value = raw.trim();
  if (value === '') return { error: 'Enter an asset id' };

  if (chain.kind === 'evm') {
    const qualified = value.toLowerCase().startsWith('eip155:');
    const address = qualified ? value.slice(value.lastIndexOf(':') + 1) : value;
    if (qualified && !value.toLowerCase().startsWith(`${chain.caip2Id.toLowerCase()}:`)) {
      return { error: `That id is for another chain. This group is ${chain.caip2Id}.` };
    }
    if (!EVM_ADDRESS.test(address)) {
      return { error: 'Enter a contract address: 0x followed by 40 hex characters' };
    }
    return { unit: `${chain.caip2Id}:${address}`.toLowerCase() };
  }

  if (chain.kind === 'cardano') {
    if (value.toLowerCase() === 'lovelace' || value.toLowerCase() === 'ada') {
      return { error: 'ADA is already in this list; pick it there' };
    }
    if (value.length > MAX_CREDIT_UNIT_LENGTH) {
      return { error: `An asset id is at most ${MAX_CREDIT_UNIT_LENGTH} characters` };
    }
    if (!CARDANO_ASSET_UNIT.test(value)) {
      if (CARDANO_ASSET_UNIT.test(value.toLowerCase())) {
        return { error: 'Use lowercase hex. The node matches this id exactly, byte for byte.' };
      }
      return {
        error:
          'Enter policy id + asset name as lowercase hex: 56 characters, then the name in pairs',
      };
    }
    // Stored verbatim: the server normalizes only EVM-shaped units, and the credit gate
    // looks this string up exactly as written.
    return { unit: value };
  }

  return { error: 'This group does not accept a custom asset' };
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

/**
 * Why an edited balance cannot be saved, or undefined when it can.
 *
 * Pulled out of the dialog's resolver so the rules are testable on their own: each one
 * exists because breaking it produces a key that looks funded and pays nothing, and
 * that is not a state a form should be able to reach quietly.
 *
 * `fundedUnits` is the set of units the ledger already holds a row for.
 */
export function creditRowProblem(
  row: { unit: string; amount: string; decimals: number },
  fundedUnits: ReadonlySet<string>,
): string | undefined {
  if (row.amount.trim() === '') {
    return 'Enter a balance, or remove this unit';
  }
  // Balances, not deltas: a negative balance is meaningless and the server rejects it
  // anyway. Precision is checked against the unit's own decimals so an over-precise
  // entry is refused instead of silently truncated on convert.
  if (!isValidDecimalAmount(row.amount, { decimals: row.decimals })) {
    return row.decimals === 0
      ? 'Enter a whole number of base units'
      : `Enter a positive amount with at most ${row.decimals} decimals`;
  }
  // A zero balance for a unit the ledger has no row for sends no delta at all
  // (creditDeltas skips it) and the server refuses to create one (400 'Invalid
  // amount'). The save would report success and leave the unit uncapped, which for
  // x402 means the key keeps spending with no ceiling.
  if (!fundedUnits.has(row.unit) && convertDecimalToBaseUnits(row.amount, row.decimals) === '0') {
    return 'Enter an amount above zero. The node cannot store a new unit at zero.';
  }
  // UnitValue.amount is a Prisma BigInt, so Postgres refuses anything past int8 with
  // `22003 value out of range`. Unchecked it leaves as a valid request and comes back
  // as a generic 'Failed to update API key', with every other field in the same PATCH
  // rolled back. Now that this field takes ADA rather than lovelace, an extra six
  // digits is an easy slip.
  if (BigInt(convertDecimalToBaseUnits(row.amount, row.decimals)) > POSTGRES_BIGINT_MAX) {
    return `Enter at most ${POSTGRES_BIGINT_MAX.toString()} base units`;
  }
  return undefined;
}
