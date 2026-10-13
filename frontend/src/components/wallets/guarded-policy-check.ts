import { cst, deserializeDatum } from '@meshsdk/core';
import { LOVELACE } from './guarded-assets';

/**
 * The owner's `UpdatePolicy` lets the transaction rewrite the whole datum, so
 * one owner signature on a bad body could rotate the agent or drain the wallet.
 * Before the owner signs, the browser decodes what the service prepared and
 * compares it with what the page shows and what the operator typed.
 *
 * Blind spot: "what the page shows" also comes from the service. This catches
 * a wrong or tampered prepare response, not a service that lies consistently.
 */

export type DecodedPolicyOutput = {
  address: string;
  /** `lovelace` and `<policy><nameHex>` units. */
  value: Map<string, bigint>;
  datumCbor: string | null;
};

export type DecodedPolicyTx = {
  outputs: DecodedPolicyOutput[];
  /** Certificates, withdrawals, mint, votes, proposals or donation. None belongs in a policy update. */
  hasOtherEffects: boolean;
};

export function decodePolicyUpdateTx(unsignedTx: string): DecodedPolicyTx {
  const body = cst.deserializeTx(unsignedTx).body();
  return {
    outputs: body.outputs().map((output) => {
      const amount = output.amount();
      const value = new Map<string, bigint>([[LOVELACE, amount.coin()]]);
      for (const [unit, quantity] of amount.multiasset() ?? new Map<string, bigint>()) {
        value.set(String(unit), quantity);
      }
      return {
        address: output.address().toBech32(),
        value,
        datumCbor: output.datum()?.asInlineData()?.toCbor() ?? null,
      };
    }),
    hasOtherEffects:
      (body.certs()?.size() ?? 0) > 0 ||
      (body.withdrawals()?.size ?? 0) > 0 ||
      (body.mint()?.size ?? 0) > 0 ||
      body.votingProcedures() != null ||
      (body.proposalProcedures()?.size() ?? 0) > 0 ||
      body.donation() != null,
  };
}

export type PolicyUpdateExpectation = {
  scriptAddress: string;
  ownerAddress: string;
  /** `<policyId><stateTokenName>`: it must stay in the wallet. */
  stateTokenUnit: string;
  agentVkh: string;
  periodLengthMs: bigint;
  periodStartMs: bigint;
  minBalanceLovelace: bigint;
  /** What the operator typed, by unit. */
  limits: Map<string, bigint>;
  /** Spent counters of the assets the current datum lists. */
  spentBefore: Map<string, bigint>;
  /** What the wallet holds now, by unit, the state token excluded. */
  heldBefore: Map<string, bigint>;
  deposit: Map<string, bigint>;
};

type WalletDatumView = {
  agent: string;
  limit: Map<string, bigint>;
  periodLength: bigint;
  periodStart: bigint;
  spentInPeriod: Map<string, bigint>;
  minBalance: bigint;
};

type PlutusJson = {
  constructor?: unknown;
  fields?: unknown;
  bytes?: unknown;
  int?: unknown;
  map?: unknown;
};

function asJson(value: unknown): PlutusJson {
  if (typeof value !== 'object' || value == null) throw new Error('not Plutus data');
  return value as PlutusJson;
}

function bytesOf(value: unknown): string {
  const { bytes } = asJson(value);
  if (typeof bytes !== 'string') throw new Error('expected bytes');
  return bytes.toLowerCase();
}

function intOf(value: unknown): bigint {
  const { int } = asJson(value);
  if (typeof int !== 'number' && typeof int !== 'bigint' && typeof int !== 'string') {
    throw new Error('expected an integer');
  }
  return BigInt(int);
}

function entriesOf(value: unknown): Array<{ k: unknown; v: unknown }> {
  const { map } = asJson(value);
  if (!Array.isArray(map)) throw new Error('expected a map');
  return map as Array<{ k: unknown; v: unknown }>;
}

/** `Value` as `{policy: {name: quantity}}`, flattened to units. Lovelace is the empty policy. */
function assetValueOf(value: unknown): Map<string, bigint> {
  const units = new Map<string, bigint>();
  for (const policy of entriesOf(value)) {
    const policyId = bytesOf(policy.k);
    for (const name of entriesOf(policy.v)) {
      const unit = policyId === '' ? LOVELACE : `${policyId}${bytesOf(name.k)}`;
      units.set(unit, intOf(name.v));
    }
  }
  return units;
}

function readWalletDatum(datumCbor: string): WalletDatumView {
  const datum = asJson(deserializeDatum(datumCbor));
  const fields = datum.fields;
  if (Number(datum.constructor) !== 0 || !Array.isArray(fields) || fields.length !== 6) {
    throw new Error('the wallet datum is not constructor 0 with 6 fields');
  }
  return {
    agent: bytesOf(fields[0]),
    limit: assetValueOf(fields[1]),
    periodLength: intOf(fields[2]),
    periodStart: intOf(fields[3]),
    spentInPeriod: assetValueOf(fields[4]),
    minBalance: intOf(fields[5]),
  };
}

function sameEntries(a: Map<string, bigint>, b: Map<string, bigint>): boolean {
  return a.size === b.size && [...a].every(([unit, quantity]) => b.get(unit) === quantity);
}

/** Why the owner must not sign this transaction, or null when it does what the operator asked. */
export function policyUpdateProblem(
  tx: DecodedPolicyTx,
  expected: PolicyUpdateExpectation,
): string | null {
  if (tx.hasOtherEffects) {
    return 'The transaction carries a certificate, withdrawal, mint or vote';
  }
  const walletOutputs = tx.outputs.filter((output) => output.address === expected.scriptAddress);
  if (walletOutputs.length !== 1) {
    return `Expected one output back to the smart wallet, found ${walletOutputs.length}`;
  }
  const strayOutput = tx.outputs.find(
    (output) =>
      output.address !== expected.scriptAddress && output.address !== expected.ownerAddress,
  );
  if (strayOutput != null) return `An output pays ${strayOutput.address}, not the owner`;

  const [wallet] = walletOutputs;
  if (wallet.value.get(expected.stateTokenUnit) !== BigInt(1)) {
    return 'The wallet output does not keep the state token';
  }
  const units = new Set([...expected.heldBefore.keys(), ...expected.deposit.keys()]);
  for (const unit of units) {
    const floor =
      (expected.heldBefore.get(unit) ?? BigInt(0)) + (expected.deposit.get(unit) ?? BigInt(0));
    if ((wallet.value.get(unit) ?? BigInt(0)) < floor) {
      return `The wallet would hold less ${unit} than it holds now plus the deposit`;
    }
  }

  if (wallet.datumCbor == null) return 'The wallet output has no inline datum';
  let datum: WalletDatumView;
  try {
    datum = readWalletDatum(wallet.datumCbor);
  } catch (error) {
    return `The wallet datum does not decode: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (datum.agent !== expected.agentVkh.toLowerCase()) return 'The datum names another agent key';
  if (datum.periodLength !== expected.periodLengthMs) return 'The datum changes the period length';
  if (datum.periodStart !== expected.periodStartMs) return 'The datum changes the period start';
  if (datum.minBalance !== expected.minBalanceLovelace)
    return 'The datum changes the minimum balance';
  if (!sameEntries(datum.limit, expected.limits))
    return 'The datum limits differ from the ones entered';
  const spent = new Map(
    [...expected.limits.keys()].map((unit) => [unit, expected.spentBefore.get(unit) ?? BigInt(0)]),
  );
  if (!sameEntries(datum.spentInPeriod, spent))
    return 'The datum resets or changes a spent counter';
  return null;
}
