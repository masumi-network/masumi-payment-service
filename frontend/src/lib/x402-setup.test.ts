import assert from 'node:assert/strict';
import test from 'node:test';
import { hasSpendableBudgetForChain, initialX402SetupStep } from './x402-setup';

test('requires a positive budget on the selected chain', () => {
  const budgets = [
    { caip2Network: 'eip155:8453', remainingAmount: '100' },
    { caip2Network: 'eip155:84532', remainingAmount: '0' },
  ];

  assert.equal(hasSpendableBudgetForChain(budgets, 'eip155:8453'), true);
  assert.equal(hasSpendableBudgetForChain(budgets, 'eip155:84532'), false);
  assert.equal(hasSpendableBudgetForChain(budgets, 'eip155:1'), false);
});

test('keeps the welcome screen while readiness is unknown', () => {
  assert.equal(
    initialX402SetupStep({
      isReadinessKnown: false,
      isReceivingReady: true,
      isPayingReady: true,
    }),
    0,
  );
});

test('keeps a fresh or incomplete rail at welcome', () => {
  assert.equal(
    initialX402SetupStep({
      isReadinessKnown: true,
      isReceivingReady: false,
      isPayingReady: false,
    }),
    0,
  );
});

test('resumes a receive-ready rail at optional paying', () => {
  assert.equal(
    initialX402SetupStep({
      isReadinessKnown: true,
      isReceivingReady: true,
      isPayingReady: false,
    }),
    3,
  );
});

test('opens the status screen for a fully configured rail', () => {
  assert.equal(
    initialX402SetupStep({
      isReadinessKnown: true,
      isReceivingReady: true,
      isPayingReady: true,
    }),
    4,
  );
});

test('add-source flow starts at chain selection even when x402 is ready', () => {
  assert.equal(
    initialX402SetupStep({
      isReadinessKnown: true,
      isReceivingReady: true,
      isPayingReady: true,
      startAtChainSelection: true,
    }),
    1,
  );
});
