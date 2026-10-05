import assert from 'node:assert/strict';
import test from 'node:test';
import { canEditAgentMetadata } from './can-edit-agent-metadata';

const v2Source = {
  paymentSourceType: 'Web3CardanoV2',
} as Parameters<typeof canEditAgentMetadata>[0]['selectedPaymentSource'];

const standardAgent = { type: 'Standard' as const };

test('A2A metadata editing is unavailable on a V2 source', () => {
  assert.equal(
    canEditAgentMetadata({
      agent: { type: 'A2A' },
      relation: 'registered',
      canPay: true,
      selectedPaymentSource: v2Source,
    }),
    false,
  );
});

test('canEditAgentMetadata matches table pencil gating', () => {
  assert.equal(
    canEditAgentMetadata({
      agent: standardAgent,
      relation: 'registered',
      canPay: true,
      selectedPaymentSource: v2Source,
    }),
    true,
  );
  assert.equal(
    canEditAgentMetadata({
      agent: standardAgent,
      relation: 'payment',
      canPay: true,
      selectedPaymentSource: v2Source,
    }),
    false,
  );
  assert.equal(
    canEditAgentMetadata({
      agent: standardAgent,
      relation: 'registered',
      canPay: false,
      selectedPaymentSource: v2Source,
    }),
    false,
  );
});
