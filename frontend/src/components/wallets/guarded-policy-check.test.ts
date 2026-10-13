import assert from 'node:assert/strict';
import test from 'node:test';
import { MeshTxBuilder, type Asset, type Data } from '@meshsdk/core';
import {
  decodePolicyUpdateTx,
  policyUpdateProblem,
  type DecodedPolicyTx,
  type PolicyUpdateExpectation,
} from './guarded-policy-check';

const SCRIPT = 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g';
const OWNER =
  'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a';
const STRANGER =
  'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
const AGENT = 'a'.repeat(56);
const STATE_POLICY = 'c'.repeat(56);
const STATE_TOKEN = `${STATE_POLICY}${'d'.repeat(8)}`;
const TUSDM_POLICY = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde';
const TUSDM = `${TUSDM_POLICY}0014df10745553444d`;

type Datum = {
  agent?: string;
  limit?: Array<[string, string, bigint]>;
  spent?: Array<[string, string, bigint]>;
  periodStart?: bigint;
};

function assetValue(entries: Array<[string, string, bigint]>): Data {
  const policies = new Map<string, Map<string, bigint>>();
  for (const [policy, name, quantity] of entries) {
    policies.set(policy, (policies.get(policy) ?? new Map()).set(name, quantity));
  }
  return new Map([...policies].map(([policy, names]) => [policy, new Map(names)])) as Data;
}

function datum(overrides: Datum = {}): Data {
  return {
    alternative: 0,
    fields: [
      overrides.agent ?? AGENT,
      assetValue(
        overrides.limit ?? [
          ['', '', BigInt(50_000_000)],
          [TUSDM_POLICY, TUSDM.slice(56), BigInt(100_000_000)],
        ],
      ),
      BigInt(86_400_000),
      overrides.periodStart ?? BigInt(1_000),
      assetValue(
        overrides.spent ?? [
          ['', '', BigInt(5_000_000)],
          [TUSDM_POLICY, TUSDM.slice(56), BigInt(0)],
        ],
      ),
      BigInt(2_000_000),
    ],
  };
}

/** A real transaction body, built offline, so the decoder runs on the bytes CIP-30 would sign. */
function policyTx(
  walletValue: Asset[],
  walletDatum: Data,
  extra: Array<[string, Asset[]]> = [],
): string {
  const builder = new MeshTxBuilder()
    .txIn('e'.repeat(64), 0, [{ unit: 'lovelace', quantity: '200000000' }], OWNER)
    .txOut(SCRIPT, walletValue)
    .txOutInlineDatumValue(walletDatum, 'Mesh');
  for (const [address, value] of extra) builder.txOut(address, value);
  return builder
    .txInCollateral('f'.repeat(64), 0, [{ unit: 'lovelace', quantity: '5000000' }], OWNER)
    .setTotalCollateral('900000')
    .setFee('600000')
    .changeAddress(OWNER)
    .completeUnbalancedSync();
}

const walletValue: Asset[] = [
  { unit: 'lovelace', quantity: '75000000' },
  { unit: STATE_TOKEN, quantity: '1' },
  { unit: TUSDM, quantity: '50000000' },
];

const expected: PolicyUpdateExpectation = {
  scriptAddress: SCRIPT,
  ownerAddress: OWNER,
  stateTokenUnit: STATE_TOKEN,
  agentVkh: AGENT,
  periodLengthMs: BigInt(86_400_000),
  periodStartMs: BigInt(1_000),
  minBalanceLovelace: BigInt(2_000_000),
  limits: new Map([
    ['lovelace', BigInt(50_000_000)],
    [TUSDM, BigInt(100_000_000)],
  ]),
  spentBefore: new Map([['lovelace', BigInt(5_000_000)]]),
  heldBefore: new Map([['lovelace', BigInt(75_000_000)]]),
  deposit: new Map([[TUSDM, BigInt(50_000_000)]]),
};

const problemOf = (tx: string, overrides: Partial<PolicyUpdateExpectation> = {}) =>
  policyUpdateProblem(decodePolicyUpdateTx(tx), { ...expected, ...overrides });

test('accepts the update the operator asked for', () => {
  assert.equal(problemOf(policyTx(walletValue, datum())), null);
});

test('refuses a rotated agent key', () => {
  assert.match(
    problemOf(policyTx(walletValue, datum({ agent: 'b'.repeat(56) })))!,
    /another agent/,
  );
});

test('refuses a moved period start', () => {
  assert.match(
    problemOf(policyTx(walletValue, datum({ periodStart: BigInt(0) })))!,
    /period start/,
  );
});

test('refuses limits other than the ones entered', () => {
  const limit: Array<[string, string, bigint]> = [['', '', BigInt(50_000_000)]];
  assert.match(problemOf(policyTx(walletValue, datum({ limit })))!, /limits differ/);
});

test('refuses a reset spent counter', () => {
  const spent: Array<[string, string, bigint]> = [
    ['', '', BigInt(0)],
    [TUSDM_POLICY, TUSDM.slice(56), BigInt(0)],
  ];
  assert.match(problemOf(policyTx(walletValue, datum({ spent })))!, /spent counter/);
});

test('refuses a wallet output that keeps less than before plus the deposit', () => {
  const short = walletValue.map((asset) =>
    asset.unit === 'lovelace' ? { ...asset, quantity: '74000000' } : asset,
  );
  assert.match(problemOf(policyTx(short, datum()))!, /less lovelace/);
});

test('refuses a wallet output without the state token', () => {
  const noToken = walletValue.filter((asset) => asset.unit !== STATE_TOKEN);
  assert.match(problemOf(policyTx(noToken, datum()))!, /state token/);
});

test('refuses an output to anyone but the owner', () => {
  const tx = policyTx(walletValue, datum(), [
    [STRANGER, [{ unit: 'lovelace', quantity: '2000000' }]],
  ]);
  assert.match(problemOf(tx)!, /not the owner/);
});

test('refuses a body with other effects', () => {
  const decoded: DecodedPolicyTx = {
    ...decodePolicyUpdateTx(policyTx(walletValue, datum())),
    hasOtherEffects: true,
  };
  assert.match(policyUpdateProblem(decoded, expected)!, /certificate/);
});

const honest = () => decodePolicyUpdateTx(policyTx(walletValue, datum()));

test('reads the fee and the collateral from the body', () => {
  assert.equal(honest().fee, BigInt(600_000));
  assert.equal(honest().totalCollateral, BigInt(900_000));
});

test('refuses a fee far above a policy update', () => {
  assert.match(policyUpdateProblem({ ...honest(), fee: BigInt(500_000_000) }, expected)!, /fee/);
});

test('refuses unbounded collateral', () => {
  assert.match(
    policyUpdateProblem({ ...honest(), totalCollateral: null }, expected)!,
    /collateral/,
  );
  assert.match(
    policyUpdateProblem({ ...honest(), totalCollateral: BigInt(50_000_000) }, expected)!,
    /collateral/,
  );
});

test('refuses a collateral return to anyone but the owner', () => {
  assert.match(
    policyUpdateProblem({ ...honest(), collateralReturnAddress: STRANGER }, expected)!,
    /collateral return/,
  );
});

test('refuses limits and spent counters in different orders', () => {
  const spent: Array<[string, string, bigint]> = [
    [TUSDM_POLICY, TUSDM.slice(56), BigInt(0)],
    ['', '', BigInt(5_000_000)],
  ];
  assert.match(problemOf(policyTx(walletValue, datum({ spent })))!, /different orders/);
});
