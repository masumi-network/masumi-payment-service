import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatMasumiOptionReviewSummary,
  formatPaymentOptionReviewLine,
  formatX402OptionReviewSummary,
  getRegisterAgentConfirmButtonLabel,
  getRegisterAgentFormDescription,
  getRegisterAgentReviewDescription,
  getRegisterAgentReviewStepButtonLabel,
  getRegisterAgentReviewTitle,
} from './register-agent-review';

test('register review labels vary by dialog mode', () => {
  assert.equal(
    getRegisterAgentReviewStepButtonLabel({ isUpdateMode: false, isReRegisterMode: false }),
    'Continue',
  );
  assert.equal(
    getRegisterAgentReviewStepButtonLabel({ isUpdateMode: true, isReRegisterMode: false }),
    'Continue',
  );
  assert.equal(
    getRegisterAgentReviewStepButtonLabel({
      isUpdateMode: false,
      isReRegisterMode: false,
      isLoadingWallets: true,
    }),
    'Loading wallets...',
  );
  assert.equal(
    getRegisterAgentReviewStepButtonLabel({
      isUpdateMode: true,
      isReRegisterMode: false,
      isLoadingWallets: true,
    }),
    'Continue',
  );
  assert.equal(
    getRegisterAgentReviewTitle({ isUpdateMode: true, isReRegisterMode: false }),
    'Review update',
  );
  assert.equal(
    getRegisterAgentConfirmButtonLabel({
      isSubmitting: false,
      isUpdateMode: false,
      isReRegisterMode: true,
    }),
    'Confirm re-registration',
  );
  assert.equal(
    getRegisterAgentConfirmButtonLabel({
      isSubmitting: true,
      isUpdateMode: true,
      isReRegisterMode: false,
    }),
    'Updating...',
  );
});

test('register review descriptions are step-aware', () => {
  assert.match(
    getRegisterAgentFormDescription({ isUpdateMode: false, isReRegisterMode: false }),
    /registers your agent/i,
  );
  assert.match(
    getRegisterAgentReviewDescription({ isUpdateMode: false, isReRegisterMode: false }),
    /Use Back/i,
  );
  assert.doesNotMatch(
    getRegisterAgentReviewDescription({ isUpdateMode: false, isReRegisterMode: true }),
    /below, then mint/i,
  );
});

test('register review payment summaries include concrete pricing', () => {
  assert.equal(
    formatMasumiOptionReviewSummary(
      {
        id: 'masumi-1',
        pricingType: 'Fixed',
        prices: [{ unit: 'lovelace', amount: '5' }],
      },
      'Preprod',
    ),
    '5 tADA',
  );
  assert.match(
    formatX402OptionReviewSummary({
      id: 'x402-1',
      pricingType: 'Fixed',
      caip2Network: 'eip155:84532',
      asset: '0x036CbD53842c542663c0287200f0f0f0f0f0f0f0',
      amount: '1.25',
      decimals: '6',
      payTo: '0x1234567890123456789012345678901234567890',
      resource: 'https://example.com/resource',
    }),
    /1\.25 0x036C\.\.\..* on eip155:84532/,
  );
  assert.match(
    formatPaymentOptionReviewLine({
      optionRow: { id: 'masumi-1', type: 'Masumi' },
      optionIndex: 0,
      masumiOption: {
        id: 'masumi-1',
        pricingType: 'Free',
        prices: [],
      },
      network: 'Mainnet',
    }).summary,
    /Masumi · Free/,
  );
});
