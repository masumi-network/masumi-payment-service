import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { RegisterAgentReviewSection } from './RegisterAgentReviewSection';
import { createAgentDefaultValues } from './register-agent-schema';

test('A2A review shows endpoint, card, protocol versions and validation override', () => {
  const markup = renderToStaticMarkup(
    createElement(RegisterAgentReviewSection, {
      values: {
        ...createAgentDefaultValues('lovelace'),
        agentType: 'A2A',
        apiUrl: 'https://agent.example/rpc',
        a2aAgentCardUrl: 'https://agent.example/card.json',
        a2aProtocolVersions: '1.0, 1.1',
        skipAgentCardValidation: true,
      },
      mintingWalletLabel: 'Mint',
      holdingWalletLabel: 'Hold',
      paymentOptionRows: [],
      masumiOptions: [],
      x402Options: [],
      verifications: [],
      isV2Target: true,
      network: 'Preprod',
      pricingSummary: 'Free',
    }),
  );
  assert.match(markup, /https:\/\/agent.example\/rpc/);
  assert.match(markup, /https:\/\/agent.example\/card.json/);
  assert.match(markup, /1.0, 1.1/);
  assert.match(markup, /Skipped/);
});
