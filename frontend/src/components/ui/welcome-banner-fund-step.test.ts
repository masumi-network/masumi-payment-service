import assert from 'node:assert/strict';
import test from 'node:test';
import { isWalletFundStepComplete } from './welcome-banner-fund-step';

test('keeps the fund step incomplete while wallet balances are loading', () => {
  assert.equal(
    isWalletFundStepComplete({
      isLoading: true,
      wallets: [{ balance: '1000000' }],
    }),
    false,
  );
});

test('keeps the fund step incomplete when wallets exist but every balance is zero', () => {
  assert.equal(
    isWalletFundStepComplete({
      isLoading: false,
      wallets: [{ balance: '0' }, { balance: '0' }],
    }),
    false,
  );
});

test('completes the fund step when at least one wallet has a positive ADA balance', () => {
  assert.equal(
    isWalletFundStepComplete({
      isLoading: false,
      wallets: [{ balance: '0' }, { balance: '2500000' }],
    }),
    true,
  );
});

test('does not complete the fund step when every balance is unavailable', () => {
  assert.equal(
    isWalletFundStepComplete({
      isLoading: false,
      wallets: [
        { balance: '0', isBalanceUnavailable: true },
        { balance: '5000000', isBalanceUnavailable: true },
      ],
    }),
    false,
  );
});

test('ignores unavailable wallets even when another wallet has zero ADA', () => {
  assert.equal(
    isWalletFundStepComplete({
      isLoading: false,
      wallets: [{ balance: '0' }, { balance: '9000000', isBalanceUnavailable: true }],
    }),
    false,
  );
});
