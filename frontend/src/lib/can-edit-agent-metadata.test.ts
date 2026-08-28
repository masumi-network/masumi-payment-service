import assert from 'node:assert/strict';
import test from 'node:test';
import { canEditAgentMetadata } from './can-edit-agent-metadata';

const v2Source = {
  paymentSourceType: 'Web3CardanoV2',
} as Parameters<typeof canEditAgentMetadata>[0]['selectedPaymentSource'];

test('canEditAgentMetadata matches table pencil gating', () => {
  assert.equal(
    canEditAgentMetadata({ relation: 'managed', canPay: true, selectedPaymentSource: v2Source }),
    true,
  );
  assert.equal(
    canEditAgentMetadata({ relation: 'payment', canPay: true, selectedPaymentSource: v2Source }),
    false,
  );
  assert.equal(
    canEditAgentMetadata({ relation: 'managed', canPay: false, selectedPaymentSource: v2Source }),
    false,
  );
});
