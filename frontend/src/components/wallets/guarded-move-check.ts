import { cst, deserializeAddress, deserializeDatum } from '@meshsdk/core';
import { LOVELACE } from './guarded-assets';
import type { GuardedHydraState } from './guarded-hydra-utils';
import {
  asJson,
  bytesOf,
  decodePolicyUpdateTx,
  entriesOf,
  intOf,
  sameEntries,
  walletDatumFromJson,
  type DecodedPolicyOutput,
  type OrderedValue,
} from './guarded-policy-check';

/**
 * A Hydra move spends the wallet with `OwnerSpend`, which needs nothing but the
 * owner's signature: one signature on a bad body could send the wallet anywhere
 * or spend the owner's own UTxOs. Before the owner signs, the browser checks
 * that the move carries the wallet, unchanged, to where the operator asked.
 *
 * Blind spots: the expected wallet comes from the service's status read, so this
 * catches a wrong or tampered prepare response, not a service that lies
 * consistently. In a head the owner's own UTxOs are not visible; the one-input,
 * one-output, exact-value rule keeps them out of a withdraw.
 */

/** The hydra 2.4.x deposit validator. The service pins the same hash (`HYDRA_DEPOSIT_SCRIPT_HASH`). */
const HYDRA_DEPOSIT_SCRIPT_HASH = 'eafae2c32f99ab347c7bb15961e0e84c74305f9088c1a7b8abf88e7f';

export type DecodedMoveTx = {
  /** `<txHash>#<index>`. */
  inputs: string[];
  collateralInputs: string[];
  outputs: DecodedPolicyOutput[];
  fee: bigint;
  hasOtherEffects: boolean;
};

type InputSet = { values(): ReadonlyArray<{ transactionId(): string; index(): bigint }> };

export function decodeMoveTx(unsignedTx: string): DecodedMoveTx {
  const { outputs, fee, hasOtherEffects } = decodePolicyUpdateTx(unsignedTx);
  const body = cst.deserializeTx(unsignedTx).body();
  const refs = (set: InputSet | undefined) =>
    (set?.values() ?? []).map((input) => `${input.transactionId()}#${input.index()}`);
  return {
    inputs: refs(body.inputs()),
    collateralInputs: refs(body.collateral()),
    outputs,
    fee,
    hasOtherEffects,
  };
}

export type MoveExpectation = {
  direction: 'deposit' | 'withdraw';
  scriptAddress: string;
  /** `<policyId><stateTokenName>`. */
  stateTokenUnit: string;
  agentVkh: string;
  periodLengthMs: bigint;
  periodStartMs: bigint;
  minBalanceLovelace: bigint;
  /** What the wallet holds now, by unit, lovelace included, the state token excluded. */
  held: Map<string, bigint>;
  limits: Map<string, bigint>;
  spent: Map<string, bigint>;
  /** Deposit: the on-chain id of the head the operator picked. */
  headIdentifier: string | null;
  /** Withdraw: the wallet UTxO the head holds. */
  walletUtxoRef: string | null;
  /** The owner's own L1 UTxOs, as the CIP-30 wallet lists them. None may be spent. */
  ownerUtxoRefs: Set<string>;
};

/** The wallet as the status read shows it, as a move must carry it. */
export function moveExpectation(params: {
  direction: MoveExpectation['direction'];
  status: GuardedHydraState;
  guarded: { scriptAddress: string; policyId: string; stateTokenName: string };
  agentVkh: string;
  headIdentifier: string | null;
  ownerUtxoRefs: Set<string>;
}): MoveExpectation {
  const { status, guarded } = params;
  const state = status.state;
  if (state == null) throw new Error('The wallet state is unknown; read the status again');
  const { assets } = state;
  const amounts = (pick: (asset: (typeof assets)[number]) => string | null) =>
    new Map(
      assets.flatMap((asset) => {
        const quantity = pick(asset);
        return quantity == null ? [] : [[asset.unit, BigInt(quantity)] as const];
      }),
    );
  const held = amounts((asset) => asset.quantity);
  for (const [unit, quantity] of held) if (quantity === BigInt(0)) held.delete(unit);
  return {
    direction: params.direction,
    scriptAddress: guarded.scriptAddress,
    stateTokenUnit: `${guarded.policyId}${guarded.stateTokenName}`,
    agentVkh: params.agentVkh,
    periodLengthMs: BigInt(state.periodLengthMs),
    periodStartMs: BigInt(new Date(state.periodStart).getTime()),
    minBalanceLovelace: BigInt(state.minBalanceLovelace),
    held,
    limits: amounts((asset) => asset.limit),
    spent: amounts((asset) => asset.spentInPeriod),
    headIdentifier: params.headIdentifier,
    walletUtxoRef: status.walletUtxoRef,
    ownerUtxoRefs: params.ownerUtxoRefs,
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function constrFields(json: unknown, alternative: number, arity: number, label: string): unknown[] {
  const { constructor, fields } = asJson(json);
  if (Number(constructor) !== alternative || !Array.isArray(fields) || fields.length !== arity) {
    throw new Error(`${label} is not constructor ${alternative} with ${arity} fields`);
  }
  return fields;
}

function listOf(json: unknown, label: string): unknown[] {
  const { list } = asJson(json);
  if (!Array.isArray(list)) throw new Error(`${label} is not a list`);
  return list;
}

/** PlutusV3 `Value`: `{policy: {name: quantity}}`, lovelace under the empty policy. */
function valueOf(json: unknown): Map<string, bigint> {
  const value = new Map<string, bigint>();
  for (const policy of entriesOf(json)) {
    const policyId = bytesOf(policy.k);
    for (const name of entriesOf(policy.v)) {
      const unit = policyId === '' ? LOVELACE : `${policyId}${bytesOf(name.k)}`;
      if (value.has(unit)) throw new Error(`the value lists ${unit} twice`);
      value.set(unit, intOf(name.v));
    }
  }
  return value;
}

/** PlutusV3 `Address`: a script payment credential and the same stake part as `bech32`. */
function isAddress(json: unknown, bech32: string): boolean {
  const want = deserializeAddress(bech32);
  const [payment, stake] = constrFields(json, 0, 2, 'address');
  const [paymentHash] = constrFields(payment, 1, 1, 'payment credential');
  if (bytesOf(paymentHash) !== want.scriptHash) return false;
  if (Number(asJson(stake).constructor) === 1) {
    return !want.stakeCredentialHash && !want.stakeScriptCredentialHash;
  }
  const [staking] = constrFields(stake, 0, 1, 'stake part');
  const [credential] = constrFields(staking, 0, 1, 'staking credential');
  const kind = Number(asJson(credential).constructor);
  const [hash] = constrFields(credential, kind, 1, 'stake credential');
  if (kind === 0) return bytesOf(hash) === want.stakeCredentialHash;
  if (kind === 1) return bytesOf(hash) === want.stakeScriptCredentialHash;
  return false;
}

function scriptHashOf(address: string): string | null {
  try {
    return deserializeAddress(address).scriptHash || null;
  } catch {
    return null;
  }
}

/** The value must be the wallet exactly: its holdings and its state token, nothing more. */
function walletValueProblem(value: Map<string, bigint>, expected: MoveExpectation): string | null {
  const want = new Map(expected.held).set(expected.stateTokenUnit, BigInt(1));
  for (const [unit, quantity] of want) {
    const actual = value.get(unit) ?? BigInt(0);
    if (actual !== quantity) return `carries ${actual} ${unit}, but the wallet holds ${quantity}`;
  }
  const extra = [...value.keys()].find((unit) => !want.has(unit));
  return extra == null ? null : `carries ${extra}, which the wallet does not hold`;
}

/** A move must keep the datum as it is. */
function walletDatumProblem(json: unknown, expected: MoveExpectation): string | null {
  let datum;
  try {
    datum = walletDatumFromJson(json);
  } catch (error) {
    return `The wallet datum does not decode: ${message(error)}`;
  }
  if (datum.agent !== expected.agentVkh.toLowerCase()) return 'The datum names another agent key';
  if (datum.periodLength !== expected.periodLengthMs) return 'The datum changes the period length';
  if (datum.periodStart !== expected.periodStartMs) return 'The datum changes the period start';
  if (datum.minBalance !== expected.minBalanceLovelace)
    return 'The datum changes the minimum balance';
  if (!sameEntries(datum.limit, expected.limits)) return 'The datum changes a limit';
  if (!sameEntries(datum.spentInPeriod, expected.spent)) return 'The datum changes a spent counter';
  const order = (value: OrderedValue) => value.map(([unit]) => unit).join(',');
  if (order(datum.limit) !== order(datum.spentInPeriod)) {
    return 'The datum lists limits and spent counters in different orders';
  }
  return null;
}

function depositProblem(tx: DecodedMoveTx, expected: MoveExpectation): string | null {
  if (expected.headIdentifier == null) return 'The head has no on-chain id yet';
  const atDeposit = tx.outputs.filter(
    (output) => scriptHashOf(output.address) === HYDRA_DEPOSIT_SCRIPT_HASH,
  );
  if (atDeposit.length !== 1) {
    return `Expected one output at the Hydra deposit script, found ${atDeposit.length}`;
  }
  const [deposit] = atDeposit;
  const valueProblem = walletValueProblem(deposit.value, expected);
  if (valueProblem != null) return `The deposit ${valueProblem}`;
  if (deposit.datumCbor == null) return 'The deposit output has no inline datum';
  try {
    // hydra 2.4.1 `DepositDatum`: (head id, deadline, [Commit { input, preSerializedOutput }]).
    const [headId, , commitsJson] = constrFields(
      deserializeDatum(deposit.datumCbor),
      0,
      3,
      'deposit datum',
    );
    if (bytesOf(headId) !== expected.headIdentifier.toLowerCase())
      return 'The deposit goes to another head';
    const commits = listOf(commitsJson, 'commits');
    if (commits.length !== 1)
      return `The deposit commits ${commits.length} outputs, not the wallet alone`;
    const [input, serialized] = constrFields(commits[0], 0, 2, 'commit');
    const [txId, index] = constrFields(input, 0, 2, 'commit input');
    if (!tx.inputs.includes(`${bytesOf(txId)}#${intOf(index)}`)) {
      return 'The commit names a UTxO the transaction does not spend';
    }
    const [address, value, outputDatum, referenceScript] = constrFields(
      deserializeDatum(bytesOf(serialized)),
      0,
      4,
      'committed output',
    );
    if (!isAddress(address, expected.scriptAddress)) {
      return 'The commit puts the wallet at another address in the head';
    }
    const commitProblem = walletValueProblem(valueOf(value), expected);
    if (commitProblem != null) return `The commit ${commitProblem}`;
    constrFields(referenceScript, 1, 0, 'reference script');
    const [inlineDatum] = constrFields(outputDatum, 2, 1, 'committed datum');
    return walletDatumProblem(inlineDatum, expected);
  } catch (error) {
    return `The deposit datum does not decode: ${message(error)}`;
  }
}

function withdrawProblem(tx: DecodedMoveTx, expected: MoveExpectation): string | null {
  if (tx.fee !== BigInt(0)) return `An in-head withdraw pays no fee, this one pays ${tx.fee}`;
  if (expected.walletUtxoRef == null) return 'The head does not hold the wallet';
  if (tx.inputs.length !== 1 || tx.inputs[0] !== expected.walletUtxoRef) {
    return 'The withdraw must spend the wallet UTxO and nothing else';
  }
  if (tx.outputs.length !== 1) return `Expected one output, found ${tx.outputs.length}`;
  const [output] = tx.outputs;
  if (output.address !== expected.scriptAddress) return 'The withdraw sends the wallet elsewhere';
  const valueProblem = walletValueProblem(output.value, expected);
  if (valueProblem != null) return `The withdraw ${valueProblem}`;
  if (output.datumCbor == null) return 'The wallet output has no inline datum';
  try {
    return walletDatumProblem(deserializeDatum(output.datumCbor), expected);
  } catch (error) {
    return `The wallet datum does not decode: ${message(error)}`;
  }
}

/** Why the owner must not sign this move, or null when it moves the wallet as asked. */
export function moveProblem(tx: DecodedMoveTx, expected: MoveExpectation): string | null {
  if (tx.hasOtherEffects) return 'The transaction carries a certificate, withdrawal, mint or vote';
  const ownerInput = [...tx.inputs, ...tx.collateralInputs].find((ref) =>
    expected.ownerUtxoRefs.has(ref),
  );
  if (ownerInput != null) return `The transaction spends the owner's own UTxO ${ownerInput}`;
  return expected.direction === 'deposit'
    ? depositProblem(tx, expected)
    : withdrawProblem(tx, expected);
}
