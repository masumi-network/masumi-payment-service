import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AIAgentRow, type AIAgent } from './AIAgentRow';

const agent = {
  id: 'agent',
  name: 'Agent',
  createdAt: '2026-10-04T00:00:00Z',
  state: 'RegistrationConfirmed',
  network: 'Preprod',
  paymentSourceType: 'Web3CardanoV2',
  SmartContractWallet: { walletVkey: 'key', walletAddress: 'addr_test1' },
  Tags: [],
  supportedPaymentSources: [],
  verifications: [],
} as unknown as AIAgent;
const noop = () => {};
function renderAgent(type: AIAgent['type'], isV2Source = true, relation?: AIAgent['relation']) {
  return renderToStaticMarkup(
    createElement(AIAgentRow, {
      agent: { ...agent, type, relation },
      index: 0,
      network: 'Preprod',
      isV2Source,
      onSelect: noop,
      onWalletClick: noop,
      onVerify: noop,
      onEarnings: noop,
      onUpdate: noop,
      onDelete: noop,
    }),
  );
}

test('only Standard agents on their V2 source offer metadata updates', () => {
  assert.match(renderAgent('Standard'), /Update agent metadata/);
  for (const type of ['A2A', 'OpenApi', 'X402'] as const) {
    assert.doesNotMatch(renderAgent(type), /Update agent metadata/);
  }
  assert.doesNotMatch(renderAgent('Standard', false), /Update agent metadata/);
  assert.doesNotMatch(renderAgent('Standard', true, 'payment'), /Update agent metadata/);
});
