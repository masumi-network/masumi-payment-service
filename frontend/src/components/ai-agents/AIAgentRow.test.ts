import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, isValidElement, type ReactNode } from 'react';
import { AIAgentRowActionsMenu } from './AIAgentRowActionsMenu';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PaymentSourceExtended } from '@/lib/api/generated';
import { AIAgentRow, type AIAgent } from './AIAgentRow';

const agent = {
  id: 'agent',
  name: 'Agent',
  createdAt: '2026-10-04T00:00:00Z',
  state: 'RegistrationConfirmed',
  network: 'Preprod' as const,
  paymentSourceType: 'Web3CardanoV2',
  SmartContractWallet: { walletVkey: 'key', walletAddress: 'addr_test1' },
  Tags: [],
  supportedPaymentSources: [],
  verifications: [],
} as unknown as AIAgent;
const noop = () => {};
function agentProps(type: AIAgent['type'], isV2Source = true, relation?: AIAgent['relation']) {
  return {
    agent: { ...agent, type, relation },
    index: 0,
    network: 'Preprod' as const,
    isSelected: false,
    showBulkSelection: false,
    capabilities: { canPay: true, canAdmin: true },
    selectedPaymentSource: {
      paymentSourceType: isV2Source ? 'Web3CardanoV2' : 'Web3CardanoV1',
    } as PaymentSourceExtended,
    onToggleSelection: noop,
    onSelect: noop,
    onWalletClick: noop,
    onVerify: noop,
    onEarnings: noop,
    onUpdate: noop,
    onDelete: noop,
  };
}

function findMenu(node: ReactNode): { showUpdateMetadata: boolean } | undefined {
  if (Array.isArray(node)) return node.map(findMenu).find(Boolean);
  if (!isValidElement<{ children?: ReactNode; showUpdateMetadata: boolean }>(node))
    return undefined;
  if (node.type === AIAgentRowActionsMenu) return node.props;
  return findMenu(node.props.children);
}

function updateAction(type: AIAgent['type'], isV2Source = true, relation?: AIAgent['relation']) {
  return findMenu(AIAgentRow(agentProps(type, isV2Source, relation)))?.showUpdateMetadata;
}

test('only Standard agents on their V2 source offer metadata updates', () => {
  assert.equal(updateAction('Standard'), true);
  for (const type of ['A2A', 'OpenApi', 'X402'] as const) {
    assert.equal(updateAction(type), false);
  }
  assert.equal(updateAction('Standard', false), false);
  assert.equal(updateAction('Standard', true, 'payment'), false);
});

test('row keeps dev wallet presentation and bulk selection', () => {
  const props = agentProps('A2A');
  const markup = renderToStaticMarkup(
    createElement(AIAgentRow, { ...props, showBulkSelection: true }),
  );
  assert.match(markup, /Select Agent/);
  assert.match(markup, /Minting &amp; holding/);
  assert.match(markup, /Agent actions/);
});
