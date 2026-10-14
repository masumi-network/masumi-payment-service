import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MeshTxBuilder,
  deserializeAddress,
  scriptAddress,
  serializeAddressObj,
  serializeData,
  type Asset,
  type Data,
} from '@meshsdk/core';
import { decodeMoveTx, moveProblem, type MoveExpectation } from './guarded-move-check';

const SCRIPT = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
const SCRIPT_HASH = deserializeAddress(SCRIPT).scriptHash;
const DEPOSIT_SCRIPT = serializeAddressObj(
  scriptAddress('eafae2c32f99ab347c7bb15961e0e84c74305f9088c1a7b8abf88e7f'),
  0,
);
const NODE =
  'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a';
const STRANGER =
  'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
const AGENT = 'a'.repeat(56);
const STATE_POLICY = 'c'.repeat(56);
const STATE_TOKEN = `${STATE_POLICY}${'d'.repeat(8)}`;
const TUSDM_POLICY = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde';
const TUSDM = `${TUSDM_POLICY}0014df10745553444d`;
const HEAD_ID = 'b'.repeat(56);
const WALLET_TX = '1'.repeat(64);
const NODE_TX = '2'.repeat(64);
const WALLET_REF = `${WALLET_TX}#0`;

const walletValue: Asset[] = [
  { unit: 'lovelace', quantity: '75000000' },
  { unit: STATE_TOKEN, quantity: '1' },
  { unit: TUSDM, quantity: '50000000' },
];

function walletDatum(agent = AGENT): Data {
  const limit = new Map([
    ['', new Map([['', BigInt(50_000_000)]])],
    [TUSDM_POLICY, new Map([[TUSDM.slice(56), BigInt(100_000_000)]])],
  ]);
  const spent = new Map([
    ['', new Map([['', BigInt(5_000_000)]])],
    [TUSDM_POLICY, new Map([[TUSDM.slice(56), BigInt(10_000_000)]])],
  ]);
  return {
    alternative: 0,
    fields: [agent, limit, BigInt(86_400_000), BigInt(1_000), spent, BigInt(2_000_000)],
  } as Data;
}

/** PlutusV3 `TxOut` of the wallet, as hydra serialises it into a commit. */
function committedOutput(options: { paymentHash?: string; agent?: string } = {}): string {
  const value = new Map([
    ['', new Map([['', BigInt(75_000_000)]])],
    [STATE_POLICY, new Map([['d'.repeat(8), BigInt(1)]])],
    [TUSDM_POLICY, new Map([[TUSDM.slice(56), BigInt(50_000_000)]])],
  ]);
  const address = {
    alternative: 0,
    fields: [
      { alternative: 1, fields: [options.paymentHash ?? SCRIPT_HASH] },
      { alternative: 1, fields: [] },
    ],
  };
  return serializeData(
    {
      alternative: 0,
      fields: [
        address,
        value,
        { alternative: 2, fields: [walletDatum(options.agent)] },
        { alternative: 1, fields: [] },
      ],
    } as Data,
    'Mesh',
  );
}

function depositDatum(
  options: { headId?: string; commitRef?: [string, number]; output?: string } = {},
): Data {
  const [txHash, index] = options.commitRef ?? [WALLET_TX, 0];
  return {
    alternative: 0,
    fields: [
      options.headId ?? HEAD_ID,
      BigInt(1_800_000_000_000),
      [
        {
          alternative: 0,
          fields: [
            { alternative: 0, fields: [txHash, BigInt(index)] },
            options.output ?? committedOutput(),
          ],
        },
      ],
    ],
  } as Data;
}

/** The deposit the node drafts: the wallet in, its value at the deposit script, node change out. */
function depositTx(options: { datum?: Data; value?: Asset[] } = {}): string {
  return new MeshTxBuilder()
    .txIn(WALLET_TX, 0, walletValue, SCRIPT)
    .txIn(NODE_TX, 0, [{ unit: 'lovelace', quantity: '20000000' }], NODE)
    .txOut(DEPOSIT_SCRIPT, options.value ?? walletValue)
    .txOutInlineDatumValue(options.datum ?? depositDatum(), 'Mesh')
    .txOut(NODE, [{ unit: 'lovelace', quantity: '19000000' }])
    .txInCollateral(NODE_TX, 1, [{ unit: 'lovelace', quantity: '5000000' }], NODE)
    .setFee('1000000')
    .changeAddress(NODE)
    .completeUnbalancedSync();
}

/** The in-head decommit: the wallet in, the same wallet out, no fee. */
function withdrawTx(
  options: { fee?: string; datum?: Data; extra?: Array<[string, Asset[]]> } = {},
): string {
  const builder = new MeshTxBuilder()
    .txIn(WALLET_TX, 0, walletValue, SCRIPT)
    .txOut(SCRIPT, walletValue)
    .txOutInlineDatumValue(options.datum ?? walletDatum(), 'Mesh');
  for (const [address, value] of options.extra ?? []) builder.txOut(address, value);
  return builder
    .setFee(options.fee ?? '0')
    .changeAddress(NODE)
    .completeUnbalancedSync();
}

const expected: MoveExpectation = {
  direction: 'deposit',
  scriptAddress: SCRIPT,
  stateTokenUnit: STATE_TOKEN,
  agentVkh: AGENT,
  periodLengthMs: BigInt(86_400_000),
  periodStartMs: BigInt(1_000),
  minBalanceLovelace: BigInt(2_000_000),
  held: new Map([
    ['lovelace', BigInt(75_000_000)],
    [TUSDM, BigInt(50_000_000)],
  ]),
  limits: new Map([
    ['lovelace', BigInt(50_000_000)],
    [TUSDM, BigInt(100_000_000)],
  ]),
  spent: new Map([
    ['lovelace', BigInt(5_000_000)],
    [TUSDM, BigInt(10_000_000)],
  ]),
  headIdentifier: HEAD_ID,
  walletUtxoRef: null,
  ownerUtxoRefs: new Set(),
};

const depositProblemOf = (tx: string, overrides: Partial<MoveExpectation> = {}) =>
  moveProblem(decodeMoveTx(tx), { ...expected, ...overrides });
const withdrawProblemOf = (tx: string, overrides: Partial<MoveExpectation> = {}) =>
  moveProblem(decodeMoveTx(tx), {
    ...expected,
    direction: 'withdraw',
    headIdentifier: null,
    walletUtxoRef: WALLET_REF,
    ...overrides,
  });

test('accepts the deposit of the wallet into the picked head', () => {
  assert.equal(depositProblemOf(depositTx()), null);
});

test('refuses a deposit into another head', () => {
  assert.match(
    depositProblemOf(depositTx({ datum: depositDatum({ headId: 'e'.repeat(56) }) }))!,
    /another head/,
  );
});

test('refuses a commit that puts the wallet at another address in the head', () => {
  const output = committedOutput({ paymentHash: 'f'.repeat(56) });
  assert.match(
    depositProblemOf(depositTx({ datum: depositDatum({ output }) }))!,
    /another address/,
  );
});

test('refuses a commit that rotates the agent key', () => {
  const output = committedOutput({ agent: 'f'.repeat(56) });
  assert.match(
    depositProblemOf(depositTx({ datum: depositDatum({ output }) }))!,
    /another agent key/,
  );
});

test('refuses a commit of a UTxO the deposit does not spend', () => {
  const datum = depositDatum({ commitRef: ['3'.repeat(64), 0] });
  assert.match(depositProblemOf(depositTx({ datum }))!, /does not spend/);
});

test('refuses a deposit output that does not carry the whole wallet', () => {
  const value = walletValue.filter((asset) => asset.unit !== TUSDM);
  assert.match(depositProblemOf(depositTx({ value }))!, /but the wallet holds/);
});

test("refuses a move that spends the owner's own UTxO", () => {
  const ownerUtxoRefs = new Set([`${NODE_TX}#1`]);
  assert.match(depositProblemOf(depositTx(), { ownerUtxoRefs })!, /owner's own UTxO/);
});

test('accepts the withdraw that recreates the wallet', () => {
  assert.equal(withdrawProblemOf(withdrawTx()), null);
});

test('refuses a withdraw with a second output', () => {
  const extra: Array<[string, Asset[]]> = [[STRANGER, [{ unit: 'lovelace', quantity: '1000000' }]]];
  assert.match(withdrawProblemOf(withdrawTx({ extra }))!, /one output/);
});

test('refuses a withdraw that pays a fee', () => {
  assert.match(withdrawProblemOf(withdrawTx({ fee: '1000000' }))!, /no fee/);
});

test('refuses a withdraw that rewrites the datum', () => {
  assert.match(
    withdrawProblemOf(withdrawTx({ datum: walletDatum('f'.repeat(56)) }))!,
    /another agent key/,
  );
});

test('refuses a withdraw of a UTxO the head does not hold', () => {
  assert.match(
    withdrawProblemOf(withdrawTx(), { walletUtxoRef: `${'4'.repeat(64)}#0` })!,
    /nothing else/,
  );
});
