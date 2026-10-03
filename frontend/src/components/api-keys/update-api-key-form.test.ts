import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUpdateApiKeySchema,
  MAX_USAGE_CREDIT_DELTAS,
  usageCreditDeltas,
  type UpdateApiKeyFormValues,
} from './update-api-key-form';

const BASE_VALUES: Omit<UpdateApiKeyFormValues, 'usageLimited' | 'credits'> = {
  newToken: '',
  status: 'Active',
  walletScopeEnabled: false,
  walletScopeIds: [],
  x402WalletScopeEnabled: false,
  x402WalletScopeIds: [],
  evmChains: [],
};

function values(
  usageLimited: boolean,
  credits: UpdateApiKeyFormValues['credits'],
): UpdateApiKeyFormValues {
  return { ...BASE_VALUES, usageLimited, credits };
}

function rows(count: number, amount: string) {
  return Array.from({ length: count }, (_, index) => ({
    unit: `unit-${index}`,
    amount,
    decimals: 0,
  }));
}

test('a usage-limited key may remove its final credit balance', () => {
  const current = [{ unit: '', amount: '1000000' }];
  const result = buildUpdateApiKeySchema(current).safeParse(values(true, []));

  assert.equal(result.success, true);
  assert.deepEqual(usageCreditDeltas(true, current, []), [{ unit: '', amount: '-1000000' }]);
});

test('exactly 25 changed balances pass local validation', () => {
  const current = rows(MAX_USAGE_CREDIT_DELTAS, '1');
  const result = buildUpdateApiKeySchema(current).safeParse(
    values(true, rows(MAX_USAGE_CREDIT_DELTAS, '2')),
  );

  assert.equal(result.success, true);
});

test('more than 25 changed balances fail local validation', () => {
  const current = rows(MAX_USAGE_CREDIT_DELTAS + 1, '1');
  const result = buildUpdateApiKeySchema(current).safeParse(
    values(true, rows(MAX_USAGE_CREDIT_DELTAS + 1, '2')),
  );

  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.error.issues[0]?.path, ['credits', 'root']);
  assert.match(result.error.issues[0]?.message ?? '', /at most 25 balances/);
});

test('unchanged ledgers with more than 25 rows remain editable', () => {
  const current = rows(MAX_USAGE_CREDIT_DELTAS + 1, '1');
  const result = buildUpdateApiKeySchema(current).safeParse(
    values(true, rows(MAX_USAGE_CREDIT_DELTAS + 1, '1')),
  );

  assert.equal(result.success, true);
});

test('an unlimited key skips credit validation and sends no deltas', () => {
  const current = rows(MAX_USAGE_CREDIT_DELTAS + 1, '1');
  const invalidRows = rows(MAX_USAGE_CREDIT_DELTAS + 1, '');
  const result = buildUpdateApiKeySchema(current).safeParse(values(false, invalidRows));

  assert.equal(result.success, true);
  assert.deepEqual(usageCreditDeltas(false, current, invalidRows), []);
});

test('an enabled wallet restriction with nothing selected fails validation', () => {
  // The deny-all state. The middleware reads an enabled flag with no rows as `[]`,
  // and only `null` means unrestricted, so the key reaches no wallet at all.
  const result = buildUpdateApiKeySchema([]).safeParse({
    ...values(false, []),
    walletScopeEnabled: true,
    walletScopeIds: [],
  });

  assert.equal(result.success, false);
  assert.match(result.error?.issues[0]?.message ?? '', /at least one wallet/);
  assert.deepEqual(result.error?.issues[0]?.path, ['walletScopeIds']);
});

test('an enabled x402 wallet restriction with nothing selected fails validation', () => {
  const result = buildUpdateApiKeySchema([]).safeParse({
    ...values(false, []),
    x402WalletScopeEnabled: true,
    x402WalletScopeIds: [],
  });

  assert.equal(result.success, false);
  assert.deepEqual(result.error?.issues[0]?.path, ['x402WalletScopeIds']);
});

test('the wallet restriction is checked on an unlimited key too', () => {
  // The rule sits above the `!usageLimited` early return on purpose. Below it, an
  // uncapped key could still be saved reaching no wallet, which is the whole bug.
  const result = buildUpdateApiKeySchema([]).safeParse({
    ...values(false, []),
    walletScopeEnabled: true,
    walletScopeIds: [],
  });

  assert.equal(result.success, false);
});

test('a wallet restriction that names a wallet passes', () => {
  const result = buildUpdateApiKeySchema([]).safeParse({
    ...values(false, []),
    walletScopeEnabled: true,
    walletScopeIds: ['wallet-1'],
  });

  assert.equal(result.success, true);
});
