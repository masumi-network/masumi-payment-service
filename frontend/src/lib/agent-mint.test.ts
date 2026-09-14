import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_MINT_BALANCE_LOVELACE,
  hasSufficientMintBalance,
  minMintBalanceAda,
} from './agent-mint';

test('minMintBalanceAda converts lovelace threshold to ADA', () => {
  assert.equal(minMintBalanceAda(), 3);
  assert.equal(MIN_MINT_BALANCE_LOVELACE, 3_000_000);
});

test('hasSufficientMintBalance requires strictly more than the threshold', () => {
  assert.equal(hasSufficientMintBalance(MIN_MINT_BALANCE_LOVELACE), false);
  assert.equal(hasSufficientMintBalance(MIN_MINT_BALANCE_LOVELACE + 1), true);
});
