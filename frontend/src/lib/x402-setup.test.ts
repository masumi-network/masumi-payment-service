import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEnableReceivingBody,
  getX402ChainSetupStatus,
  inferX402ReceiveMode,
  initialX402SetupStep,
  pickInitialX402Chain,
} from './x402-setup';

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

type TestChain = {
  id: string;
  caip2Id: string;
  displayName: string;
  rpcUrl: string;
  isTestnet: boolean;
  isEnabled: boolean;
  facilitatorWalletId: string | null;
  facilitatorUrl: string | null;
};

const chain = (overrides: Partial<TestChain> = {}): TestChain => ({
  id: 'chain-a',
  caip2Id: 'eip155:84532',
  displayName: 'Base Sepolia',
  rpcUrl: 'https://sepolia.base.org',
  isTestnet: true,
  isEnabled: true,
  facilitatorWalletId: null,
  facilitatorUrl: null,
  ...overrides,
});

test('chain status: enabled with a facilitator and RPC is ready', () => {
  assert.equal(getX402ChainSetupStatus(chain({ facilitatorWalletId: 'w1' })), 'ready');
  assert.equal(getX402ChainSetupStatus(chain({ facilitatorUrl: 'https://f.example' })), 'ready');
});

test('chain status: no facilitator needs one, enabled or not', () => {
  assert.equal(getX402ChainSetupStatus(chain()), 'needs-facilitator');
  assert.equal(getX402ChainSetupStatus(chain({ isEnabled: false })), 'needs-facilitator');
});

test('chain status: a configured but switched-off chain is disabled', () => {
  assert.equal(
    getX402ChainSetupStatus(chain({ isEnabled: false, facilitatorWalletId: 'w1' })),
    'disabled',
  );
});

test('receive mode follows an existing remote facilitator, else this node', () => {
  assert.equal(inferX402ReceiveMode(chain({ facilitatorUrl: 'https://f.example' })), 'remote');
  assert.equal(inferX402ReceiveMode(chain({ facilitatorWalletId: 'w1' })), 'node');
  assert.equal(inferX402ReceiveMode(null), 'node');
});

test('initial chain prefers the remembered chain, then a ready chain, then the first', () => {
  const draft = chain({ id: 'draft' });
  const ready = chain({ id: 'ready', facilitatorWalletId: 'w1' });
  assert.equal(pickInitialX402Chain([draft, ready], 'draft')?.id, 'draft');
  assert.equal(pickInitialX402Chain([draft, ready], 'gone')?.id, 'ready');
  assert.equal(pickInitialX402Chain([draft], null)?.id, 'draft');
  assert.equal(pickInitialX402Chain([], null), null);
});

test('enable body for this node assigns the wallet, clears the URL and enables the chain', () => {
  assert.deepEqual(
    buildEnableReceivingBody(chain({ isEnabled: false }), { mode: 'node', sellingWalletId: 'w1' }),
    {
      caip2Id: 'eip155:84532',
      displayName: 'Base Sepolia',
      rpcUrl: 'https://sepolia.base.org',
      isTestnet: true,
      isEnabled: true,
      facilitatorWalletId: 'w1',
      facilitatorUrl: null,
    },
  );
});

test('enable body for a remote facilitator trims input and omits blank auth', () => {
  const body = buildEnableReceivingBody(chain(), {
    mode: 'remote',
    facilitatorUrl: ' https://f.example/x402 ',
    facilitatorAuth: '   ',
  });
  assert.equal(body.facilitatorUrl, 'https://f.example/x402');
  assert.equal('facilitatorAuth' in body, false);
  assert.equal('facilitatorWalletId' in body, false);
  assert.equal(
    buildEnableReceivingBody(chain(), {
      mode: 'remote',
      facilitatorUrl: 'https://f.example',
      facilitatorAuth: 'Bearer t',
    }).facilitatorAuth,
    'Bearer t',
  );
});
