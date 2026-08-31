import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ADA_CREDIT_UNIT,
  buildCustomCreditUnit,
  consolidateCreditRows,
  creditDeltas,
  creditRowProblem,
  creditUnitOptionsForKey,
  normalizeCreditUnit,
  shortenCreditUnit,
  type CreditUnitOption,
} from './api-key-credit-units';

const BASE_MAINNET = {
  caip2Id: 'eip155:8453',
  displayName: 'Base Mainnet',
  defaultAsset: null,
  defaultAssetDecimals: null,
};

const USDM_MAINNET = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';

function units(options: CreditUnitOption[]): string[] {
  return options.map((option) => option.unit);
}

test('ADA is offered as the empty unit, not lovelace', () => {
  // The purchase path normalizes 'lovelace' to '' before the credit gate compares it,
  // so a row stored as 'lovelace' can never match an ADA purchase.
  const options = creditUnitOptionsForKey({
    networkLimit: ['Mainnet'],
    chainIdLimit: [],
    evmNetworks: [],
  });
  const ada = options.find((option) => option.label === 'ADA');
  assert.ok(ada);
  assert.equal(ada.unit, ADA_CREDIT_UNIT);
  assert.equal(ada.unit, '');
});

test('a Mainnet key can be funded in USDM, not only the active stablecoin', () => {
  // getActiveStablecoinConfig('Mainnet') is USDCx, so the old two-field form could not
  // fund a key for USDM at all, which is what the Cardano V1 agents actually charge.
  const options = creditUnitOptionsForKey({
    networkLimit: ['Mainnet'],
    chainIdLimit: [],
    evmNetworks: [],
  });
  assert.ok(units(options).includes(USDM_MAINNET));
});

test('EVM chains in the key limit contribute canonical lowercase units', () => {
  const options = creditUnitOptionsForKey({
    networkLimit: ['Mainnet'],
    chainIdLimit: ['cardano:mainnet', 'eip155:8453'],
    evmNetworks: [BASE_MAINNET],
  });
  const usdc = options.find((option) => option.unit.startsWith('eip155:8453:'));
  assert.ok(usdc);
  assert.equal(usdc.unit, 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  assert.equal(usdc.group, 'Base Mainnet');
});

test('an EVM chain the node does not know contributes nothing', () => {
  const options = creditUnitOptionsForKey({
    networkLimit: [],
    chainIdLimit: ['eip155:999999'],
    evmNetworks: [BASE_MAINNET],
  });
  assert.deepEqual(options, []);
});

test('a chain configured with its own default asset wins over the preset', () => {
  const options = creditUnitOptionsForKey({
    networkLimit: [],
    chainIdLimit: ['eip155:8453'],
    evmNetworks: [
      {
        ...BASE_MAINNET,
        defaultAsset: '0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333',
        defaultAssetDecimals: 18,
      },
    ],
  });
  const configured = options.find((option) => option.decimals === 18);
  assert.ok(configured);
  assert.equal(configured.unit, 'eip155:8453:0xaaaabbbbccccddddeeeeffff0000111122223333');
});

test('a unit already on the key stays visible even when unrecognised', () => {
  // Otherwise a balance the operator has to see is simply absent from the form.
  const options = creditUnitOptionsForKey({
    networkLimit: ['Preprod'],
    chainIdLimit: [],
    evmNetworks: [],
    existingUnits: ['deadbeef'.repeat(8)],
  });
  const stale = options.find((option) => option.group === 'Already on this key');
  assert.ok(stale);
  assert.equal(stale.unit, 'deadbeef'.repeat(8));
});

test('a stale lovelace row is surfaced next to the canonical ADA entry', () => {
  const options = creditUnitOptionsForKey({
    networkLimit: ['Mainnet'],
    chainIdLimit: [],
    evmNetworks: [],
    existingUnits: ['lovelace'],
  });
  assert.ok(units(options).includes(''));
  assert.ok(units(options).includes('lovelace'));
});

test('existing units are not duplicated when already offered', () => {
  const options = creditUnitOptionsForKey({
    networkLimit: ['Mainnet'],
    chainIdLimit: [],
    evmNetworks: [],
    existingUnits: [USDM_MAINNET, ''],
  });
  assert.equal(units(options).filter((unit) => unit === USDM_MAINNET).length, 1);
  assert.equal(units(options).filter((unit) => unit === '').length, 1);
});

test('creditDeltas sends only what changed', () => {
  const deltas = creditDeltas(
    [
      { unit: '', amount: '1000000' },
      { unit: USDM_MAINNET, amount: '5000000' },
    ],
    [
      { unit: '', amount: '1000000' },
      { unit: USDM_MAINNET, amount: '9000000' },
    ],
  );
  assert.deepEqual(deltas, [{ unit: USDM_MAINNET, amount: '4000000' }]);
});

test('creditDeltas emits a negative delta when a balance is lowered', () => {
  const deltas = creditDeltas([{ unit: '', amount: '3000000' }], [{ unit: '', amount: '1000000' }]);
  assert.deepEqual(deltas, [{ unit: '', amount: '-2000000' }]);
});

test('creditDeltas zeroes a unit the operator removed', () => {
  // Removing a row used to send nothing at all, so the stored balance survived and the
  // form claimed a change it never made.
  const deltas = creditDeltas(
    [
      { unit: '', amount: '3000000' },
      { unit: USDM_MAINNET, amount: '5000000' },
    ],
    [{ unit: '', amount: '3000000' }],
  );
  assert.deepEqual(deltas, [{ unit: USDM_MAINNET, amount: '-5000000' }]);
});

test('creditDeltas leaves an already-zero removed unit alone', () => {
  // A zero delta for an existing row is pointless, and the server keeps zeroed rows as
  // the record that the key is capped on that unit.
  const deltas = creditDeltas([{ unit: USDM_MAINNET, amount: '0' }], []);
  assert.deepEqual(deltas, []);
});

test('creditDeltas ignores a unit added and removed before saving', () => {
  const deltas = creditDeltas([], []);
  assert.deepEqual(deltas, []);
});

test('creditDeltas treats a brand new unit as its full amount', () => {
  const deltas = creditDeltas([], [{ unit: USDM_MAINNET, amount: '2500000' }]);
  assert.deepEqual(deltas, [{ unit: USDM_MAINNET, amount: '2500000' }]);
});

test('shortenCreditUnit leaves short units alone', () => {
  assert.equal(shortenCreditUnit('lovelace'), 'lovelace');
  assert.equal(shortenCreditUnit(USDM_MAINNET).length < USDM_MAINNET.length, true);
});

test('consolidateCreditRows sums duplicate rows for one unit', () => {
  // The node holds more than one row per unit in practice: its own purchase path
  // collapses duplicates when it debits. Diffing against only one of them made the
  // dialog compute a delta that moved the balance to the wrong total.
  assert.deepEqual(
    consolidateCreditRows([
      { unit: '', amount: '100' },
      { unit: 'eip155:8453:0xabc', amount: '5' },
      { unit: '', amount: '50' },
    ]),
    [
      { unit: '', amount: '150' },
      { unit: 'eip155:8453:0xabc', amount: '5' },
    ],
  );
});

test('consolidateCreditRows leaves a single row per unit untouched', () => {
  assert.deepEqual(consolidateCreditRows([{ unit: '', amount: '100' }]), [
    { unit: '', amount: '100' },
  ]);
  assert.deepEqual(consolidateCreditRows([]), []);
});

test('buildCustomCreditUnit chain-qualifies and lowercases a bare EVM address', () => {
  // The x402 debit lowercases the asset address before it looks the row up, so a
  // checksummed address — the form a wallet or explorer puts on the clipboard —
  // would be stored verbatim and never match.
  assert.deepEqual(
    buildCustomCreditUnit(
      { kind: 'evm', caip2Id: 'eip155:8453' },
      '0x833589FCD6EDB6E08F4C7C32D4F71B54BDA02913',
    ),
    { unit: 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  );
});

test('buildCustomCreditUnit accepts an already-qualified unit for the same chain', () => {
  assert.deepEqual(
    buildCustomCreditUnit(
      { kind: 'evm', caip2Id: 'eip155:8453' },
      'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    ),
    { unit: 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  );
});

test('buildCustomCreditUnit refuses a unit qualified for another chain', () => {
  // Silently re-homing it would fund the key on a chain the operator did not pick.
  const result = buildCustomCreditUnit(
    { kind: 'evm', caip2Id: 'eip155:8453' },
    'eip155:84532:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  );
  assert.ok('error' in result);
  assert.match(result.error, /another chain/);
});

test('buildCustomCreditUnit refuses a malformed EVM address', () => {
  // findNonCanonicalEvmCreditUnit fails these closed on the server; catching them
  // here keeps the dialog from posting a save that can only 400.
  for (const bad of ['0x1234', 'native', '833589fcd6edb6e08f4c7c32d4f71b54bda02913']) {
    const result = buildCustomCreditUnit({ kind: 'evm', caip2Id: 'eip155:8453' }, bad);
    assert.ok('error' in result, bad);
  }
});

test('buildCustomCreditUnit stores a lowercase Cardano unit verbatim', () => {
  // Stored exactly as written: the server normalizes only EVM-shaped units, so this
  // string is what the credit gate will look up.
  const unit = `${'a'.repeat(56)}44654144`;
  assert.deepEqual(buildCustomCreditUnit({ kind: 'cardano', network: 'Mainnet' }, unit), { unit });
});

test('buildCustomCreditUnit refuses a Cardano id that is not policy id + asset name hex', () => {
  for (const bad of ['a'.repeat(55), `${'a'.repeat(56)}4`, 'not-hex-at-all']) {
    const result = buildCustomCreditUnit({ kind: 'cardano', network: 'Mainnet' }, bad);
    assert.ok('error' in result, bad);
  }
});

test('buildCustomCreditUnit points lovelace at the ADA option instead of storing it', () => {
  // A row stored as 'lovelace' can never match an ADA purchase: the purchase path
  // maps 'lovelace' to '' before the credit gate compares units.
  const result = buildCustomCreditUnit({ kind: 'cardano', network: 'Mainnet' }, 'lovelace');
  assert.ok('error' in result);
  assert.match(result.error, /ADA is already in this list/);
});

test('buildCustomCreditUnit rejects an empty entry and an unknown chain', () => {
  assert.ok('error' in buildCustomCreditUnit({ kind: 'cardano', network: 'Mainnet' }, '   '));
  assert.ok('error' in buildCustomCreditUnit({ kind: 'unknown' }, 'a'.repeat(56)));
});

test('buildCustomCreditUnit refuses uppercase Cardano hex and says why', () => {
  // The credit gate keys a Map by the stored string and looks up the requested unit
  // byte for byte (credit-init-transaction.ts). Cardano tooling emits lowercase hex,
  // so an uppercase row matches nothing and every purchase in that asset fails with
  // `Credit unit not found` while the dialog shows the balance as funded.
  const result = buildCustomCreditUnit(
    { kind: 'cardano', network: 'Mainnet' },
    USDM_MAINNET.toUpperCase(),
  );
  assert.ok('error' in result);
  assert.match(result.error, /lowercase/);
});

test('a unit read back off the ledger is edited in base units', () => {
  // Nothing records the decimals of an asset no preset describes, and PATCH carries
  // only unit and amount, so an assumed 6dp cannot survive a reopen: the same stored
  // balance would read back rescaled by a million.
  const options = creditUnitOptionsForKey({
    networkLimit: [],
    chainIdLimit: [],
    evmNetworks: [],
    existingUnits: ['aabbcc'],
  });
  const recovered = options.find((option) => option.unit === 'aabbcc');
  assert.ok(recovered);
  assert.equal(recovered.decimals, 0);
  assert.equal(recovered.chain.kind, 'unknown');
});

test('two chains sharing a display name stay separate groups', () => {
  // X402Network.caip2Id is unique; displayName is free text and is not. Grouping by
  // the name merged both chains into one picker group with a single custom-asset
  // entry, which then qualified the asset for whichever chain came first.
  const options = creditUnitOptionsForKey({
    networkLimit: [],
    chainIdLimit: ['eip155:8453', 'eip155:84532'],
    evmNetworks: [
      { ...BASE_MAINNET, displayName: 'Base' },
      { ...BASE_MAINNET, caip2Id: 'eip155:84532', displayName: 'Base' },
    ],
  });
  const groupIds = new Set(options.map((option) => option.groupId));
  assert.deepEqual([...groupIds].sort(), ['eip155:8453', 'eip155:84532']);
  assert.deepEqual(new Set(options.map((option) => option.group)), new Set(['Base']));
});

test('Cardano and EVM group ids never collide', () => {
  const options = creditUnitOptionsForKey({
    networkLimit: ['Mainnet', 'Preprod'],
    chainIdLimit: ['eip155:8453'],
    evmNetworks: [BASE_MAINNET],
  });
  assert.deepEqual([...new Set(options.map((option) => option.groupId))].sort(), [
    'cardano:mainnet',
    'cardano:preprod',
    'eip155:8453',
  ]);
});

const NO_FUNDED_UNITS = new Set<string>();

test('creditRowProblem refuses a new unit at zero, whatever shape the zero takes', () => {
  // creditDeltas drops a zero delta and the request omits the field entirely, so the
  // save reports success and creates nothing. For x402 that leaves a key its operator
  // believes is capped spending against the wallet's whole balance.
  for (const amount of ['0', '0.0', '0.00', '.0', '0.']) {
    assert.match(
      creditRowProblem({ unit: '', amount, decimals: 6 }, NO_FUNDED_UNITS) ?? '',
      /above zero/,
      amount,
    );
  }
});

test('creditRowProblem allows zeroing a unit the ledger already holds', () => {
  // Zeroing an existing row is a real delta and the server keeps the row, which is the
  // record that the key is capped on that unit.
  assert.equal(creditRowProblem({ unit: '', amount: '0', decimals: 6 }, new Set([''])), undefined);
});

test('creditRowProblem rejects a blank amount rather than treating it as zero', () => {
  assert.match(
    creditRowProblem({ unit: '', amount: '   ', decimals: 6 }, NO_FUNDED_UNITS) ?? '',
    /Enter a balance/,
  );
});

test('creditRowProblem names base units when the row has no decimals', () => {
  assert.match(
    creditRowProblem({ unit: 'zz', amount: '1.5', decimals: 0 }, NO_FUNDED_UNITS) ?? '',
    /whole number of base units/,
  );
  assert.equal(
    creditRowProblem({ unit: 'zz', amount: '150', decimals: 0 }, NO_FUNDED_UNITS),
    undefined,
  );
});

test('creditRowProblem refuses an over-precise amount instead of truncating it', () => {
  assert.match(
    creditRowProblem({ unit: '', amount: '1.1234567', decimals: 6 }, NO_FUNDED_UNITS) ?? '',
    /at most 6 decimals/,
  );
  assert.equal(
    creditRowProblem({ unit: '', amount: '1.123456', decimals: 6 }, NO_FUNDED_UNITS),
    undefined,
  );
});

test('creditRowProblem rejects negatives and exponent notation', () => {
  // A balance, not a delta. convertDecimalToBaseUnits would also throw on '1e5'.
  for (const amount of ['-1', '1e5', 'abc']) {
    assert.notEqual(
      creditRowProblem({ unit: '', amount, decimals: 6 }, NO_FUNDED_UNITS),
      undefined,
      amount,
    );
  }
});

test('creditRowProblem refuses a balance past what int8 can hold', () => {
  // UnitValue.amount is a Prisma BigInt. Unbounded, the request is valid, Postgres
  // raises 22003 on write, and the operator gets a generic failure with every other
  // field of the same PATCH rolled back.
  assert.match(
    creditRowProblem({ unit: '', amount: '10000000000000', decimals: 6 }, NO_FUNDED_UNITS) ?? '',
    /at most 9223372036854775807 base units/,
  );
});

test('creditRowProblem allows the largest balance int8 can hold', () => {
  // The bound is inclusive: 9223372036854775807 base units is storable, and rejecting
  // it would refuse a value the ledger accepts.
  assert.equal(
    creditRowProblem({ unit: '', amount: '9223372036854775807', decimals: 0 }, NO_FUNDED_UNITS),
    undefined,
  );
});

test('normalizeCreditUnit folds lovelace onto the canonical ADA unit', () => {
  // The server rewrites the unit it stores, so a 'lovelace' row is an ADA row that
  // has not been touched since. Treating it as its own asset is what let the dialog
  // offer an edit PATCH cannot express.
  assert.equal(normalizeCreditUnit('lovelace'), ADA_CREDIT_UNIT);
  assert.equal(normalizeCreditUnit('Lovelace'), ADA_CREDIT_UNIT);
  assert.equal(normalizeCreditUnit(ADA_CREDIT_UNIT), ADA_CREDIT_UNIT);
});

test('normalizeCreditUnit lowercases a checksummed EVM unit', () => {
  assert.equal(
    normalizeCreditUnit('eip155:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  );
});

test('normalizeCreditUnit leaves a Cardano native asset verbatim', () => {
  // Asset-name hex is case-significant and the credit gate matches it byte for byte,
  // so lowercasing one here would group two genuinely different assets.
  const unit = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
  assert.equal(normalizeCreditUnit(unit), unit);
});

test('consolidateCreditRows folds a legacy lovelace row into the ADA row', () => {
  // The reported bug: two editable rows for one asset. Removing the 3 ADA row sent a
  // delta the server normalized onto '' and took off the live balance instead.
  assert.deepEqual(
    consolidateCreditRows([
      { unit: '', amount: '5000000' },
      { unit: 'lovelace', amount: '3000000' },
    ]),
    [{ unit: '', amount: '8000000' }],
  );
});

test('consolidateCreditRows folds EVM rows that differ only in address case', () => {
  assert.deepEqual(
    consolidateCreditRows([
      { unit: 'eip155:8453:0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10' },
      { unit: 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '5' },
    ]),
    [{ unit: 'eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', amount: '15' }],
  );
});

test('consolidateCreditRows keeps distinct Cardano assets apart', () => {
  const usdm = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
  assert.deepEqual(
    consolidateCreditRows([
      { unit: '', amount: '1' },
      { unit: usdm, amount: '2' },
    ]),
    [
      { unit: '', amount: '1' },
      { unit: usdm, amount: '2' },
    ],
  );
});
