import type { GetWalletGuardedResponses, PostWalletGuardedPolicyData } from '@/lib/api/generated';
import {
  decimalsOf,
  assetLabelOf,
  governableAssets,
  LOVELACE,
  unitOfAssetId,
} from './guarded-assets';
import type { PolicyUpdateExpectation } from './guarded-policy-check';
import { formatDecimalString, parseDecimalToRawAmount } from './wallet-details-utils';

type Network = 'Preprod' | 'Mainnet';
type GuardedState = NonNullable<GetWalletGuardedResponses[200]['data']>;
export type GuardedRecord = NonNullable<GuardedState['guardedWallet']>;
export type GuardedChain = NonNullable<GuardedState['chain']>;
export type PolicyBody = NonNullable<PostWalletGuardedPolicyData['body']>;

/** One asset in the "Limits and deposit" form. An empty limit leaves the asset unlisted. */
export type PolicyRow = {
  unit: string;
  label: string;
  /** 6 for a known asset (whole units typed); 0 for any other (raw minor units typed). */
  decimals: number;
  limit: string;
  deposit: string;
  /** Lovelace and the payment asset must stay listed. */
  isRequired: boolean;
  /** The wallet holds it, so it must stay listed or it would freeze. */
  isHeld: boolean;
};

const display = (quantity: string, decimals: number) =>
  decimals === 0 ? quantity : formatDecimalString(quantity, decimals);

/** The wallet's assets with their current limits, then the governable ones it does not list yet. */
export function policyRowsFor(
  chain: GuardedChain,
  governedAsset: string,
  network: Network,
): PolicyRow[] {
  const governedUnit = unitOfAssetId(governedAsset);
  const row = (unit: string, limit: string | null, quantity: string): PolicyRow => {
    const decimals = decimalsOf(unit, network);
    return {
      unit,
      label: assetLabelOf(unit, network),
      decimals,
      limit: limit == null ? '' : display(limit, decimals),
      deposit: '',
      isRequired: unit === LOVELACE || unit === governedUnit,
      isHeld: BigInt(quantity) > BigInt(0),
    };
  };
  const rows = chain.assets.map((asset) => row(asset.unit, asset.limit, asset.quantity));
  for (const asset of governableAssets(network)) {
    if (!rows.some((existing) => existing.unit === asset.unit))
      rows.push(row(asset.unit, null, '0'));
  }
  return rows;
}

/** The prepare request, or what is wrong with the form. The service checks the same rules. */
export function buildPolicyBody(
  hotWalletId: string,
  rows: PolicyRow[],
): { body: PolicyBody } | { error: string } {
  const limits: PolicyBody['limits'] = [];
  const deposit: NonNullable<PolicyBody['deposit']> = [];
  for (const row of rows) {
    const isListed = row.limit.trim() !== '';
    if (!isListed && (row.isRequired || row.isHeld)) {
      return { error: `${row.label} must keep a limit` };
    }
    if (isListed) {
      const amount = parseDecimalToRawAmount(row.limit, row.decimals);
      if (amount == null) return { error: `Enter a valid ${row.label} limit` };
      limits.push({ unit: row.unit, amount });
    }
    if (row.deposit.trim() === '') continue;
    const amount = parseDecimalToRawAmount(row.deposit, row.decimals);
    if (amount == null || amount === '0') return { error: `Enter a positive ${row.label} deposit` };
    if (!isListed) return { error: `Give ${row.label} a limit before depositing it` };
    deposit.push({ unit: row.unit, amount });
  }
  return { body: { hotWalletId, limits, deposit } };
}

/** What the prepared transaction must do, from the page's state and the request. */
export function policyExpectation(params: {
  guarded: GuardedRecord;
  chain: GuardedChain;
  agentVkh: string;
  body: PolicyBody;
}): PolicyUpdateExpectation {
  const { guarded, chain, body } = params;
  const byUnit = (amounts: Array<{ unit: string; amount: string }>) =>
    new Map(amounts.map(({ unit, amount }) => [unit, BigInt(amount)]));
  return {
    scriptAddress: guarded.scriptAddress,
    ownerAddress: guarded.ownerAddress,
    stateTokenUnit: `${guarded.policyId}${guarded.stateTokenName}`,
    agentVkh: params.agentVkh,
    periodLengthMs: BigInt(chain.periodLengthMs),
    periodStartMs: BigInt(new Date(chain.periodStart).getTime()),
    minBalanceLovelace: BigInt(chain.minBalanceLovelace),
    limits: byUnit(body.limits),
    spentBefore: new Map(
      chain.assets.flatMap((asset) =>
        asset.spentInPeriod == null ? [] : [[asset.unit, BigInt(asset.spentInPeriod)] as const],
      ),
    ),
    heldBefore: new Map(chain.assets.map((asset) => [asset.unit, BigInt(asset.quantity)])),
    deposit: byUnit(body.deposit ?? []),
  };
}
