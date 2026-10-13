import assert from 'node:assert/strict';
import test from 'node:test';
import { assetIdOfUnit, formatAssetAmount, unitOfAssetId } from './guarded-assets';
import {
  buildPolicyBody,
  policyExpectation,
  policyRowsFor,
  type GuardedChain,
  type GuardedRecord,
} from './guarded-policy-form';

const TUSDM = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde0014df10745553444d';
const TUSDM_ID = '16a55b2a349361ff88c03788f93e1e966e5d689605d044fef722ddde.0014df10745553444d';
const OTHER = `${'0'.repeat(56)}abcd`;

const chain = {
  lovelace: '75000000',
  periodLimitLovelace: '50000000',
  spentInPeriodLovelace: '5000000',
  periodStart: new Date(1_000),
  periodLengthMs: '86400000',
  minBalanceLovelace: '2000000',
  assets: [
    { unit: 'lovelace', quantity: '75000000', limit: '50000000', spentInPeriod: '5000000' },
    { unit: OTHER, quantity: '3', limit: null, spentInPeriod: null },
  ],
} as GuardedChain;

test('converts between chain units and Exchain asset ids', () => {
  assert.equal(assetIdOfUnit(TUSDM), TUSDM_ID);
  assert.equal(unitOfAssetId(TUSDM_ID), TUSDM);
  assert.equal(assetIdOfUnit(''), 'lovelace');
  assert.equal(formatAssetAmount('5000000', TUSDM, 'Preprod'), '5 tUSDM');
  assert.match(formatAssetAmount('3', OTHER, 'Preprod'), /^3 .* \(raw\)$/);
});

test('lists held assets with their limits, then governable assets not listed yet', () => {
  const rows = policyRowsFor(chain, 'lovelace', 'Preprod');
  assert.deepEqual(
    rows.map(({ unit, limit, isRequired, isHeld, decimals }) => ({
      unit,
      limit,
      isRequired,
      isHeld,
      decimals,
    })),
    [
      { unit: 'lovelace', limit: '50', isRequired: true, isHeld: true, decimals: 6 },
      { unit: OTHER, limit: '', isRequired: false, isHeld: true, decimals: 0 },
      { unit: TUSDM, limit: '', isRequired: false, isHeld: false, decimals: 6 },
    ],
  );
});

test('builds limits and a deposit in minor units', () => {
  const rows = policyRowsFor(chain, 'lovelace', 'Preprod').map((row) =>
    row.unit === TUSDM
      ? { ...row, limit: '100', deposit: '50' }
      : row.unit === OTHER
        ? { ...row, limit: '3' }
        : row,
  );
  assert.deepEqual(buildPolicyBody('hw-1', rows), {
    body: {
      hotWalletId: 'hw-1',
      limits: [
        { unit: 'lovelace', amount: '50000000' },
        { unit: OTHER, amount: '3' },
        { unit: TUSDM, amount: '100000000' },
      ],
      deposit: [{ unit: TUSDM, amount: '50000000' }],
    },
  });
});

test('refuses to drop a held asset, which would freeze it', () => {
  assert.deepEqual(buildPolicyBody('hw-1', policyRowsFor(chain, 'lovelace', 'Preprod')), {
    error: `${policyRowsFor(chain, 'lovelace', 'Preprod')[1].label} must keep a limit`,
  });
});

test('refuses a deposit of an asset without a limit', () => {
  const rows = policyRowsFor(chain, 'lovelace', 'Preprod').map((row) =>
    row.unit === TUSDM
      ? { ...row, deposit: '5' }
      : row.unit === OTHER
        ? { ...row, limit: '3' }
        : row,
  );
  assert.deepEqual(buildPolicyBody('hw-1', rows), {
    error: 'Give tUSDM a limit before depositing it',
  });
});

test('expects the old spent counters and the current holdings', () => {
  const expectation = policyExpectation({
    guarded: {
      scriptAddress: 'addr_script',
      ownerAddress: 'addr_owner',
      policyId: 'c'.repeat(56),
      stateTokenName: 'dd',
    } as GuardedRecord,
    chain,
    agentVkh: 'a'.repeat(56),
    body: { hotWalletId: 'hw-1', limits: [{ unit: 'lovelace', amount: '1' }], deposit: [] },
  });
  assert.equal(expectation.stateTokenUnit, `${'c'.repeat(56)}dd`);
  assert.equal(expectation.periodStartMs, BigInt(1_000));
  assert.deepEqual([...expectation.spentBefore], [['lovelace', BigInt(5_000_000)]]);
  assert.deepEqual(
    [...expectation.heldBefore],
    [
      ['lovelace', BigInt(75_000_000)],
      [OTHER, BigInt(3)],
    ],
  );
});
