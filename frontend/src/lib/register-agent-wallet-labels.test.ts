import assert from 'node:assert/strict';
import test from 'node:test';
import { getHoldingWalletLabel, getMintingWalletLabel } from './register-agent-wallet-labels';

const address = 'addr_test123456789012345678901234567890';
const shortAddress = 'addr_tes...34567890';
const wallet = { walletAddress: address, note: 'Minting wallet' };

test('registration review identifies the selected minting wallet', () => {
  assert.equal(getMintingWalletLabel(false, undefined, wallet), `Minting wallet (${shortAddress})`);
  assert.equal(getMintingWalletLabel(false, undefined, { ...wallet, note: null }), shortAddress);
  assert.equal(getMintingWalletLabel(false, undefined, undefined), '—');
});

test('update review identifies the current holder instead of the selected minting wallet', () => {
  assert.equal(getMintingWalletLabel(true, address, undefined), shortAddress);
  assert.equal(getMintingWalletLabel(true, undefined, wallet), 'Current holder wallet');
});

test('holding wallet review preserves the default, named wallet, and external address labels', () => {
  assert.equal(getHoldingWalletLabel(undefined, [wallet]), 'Use minting wallet (default)');
  assert.equal(getHoldingWalletLabel('', [wallet]), 'Use minting wallet (default)');
  assert.equal(getHoldingWalletLabel(address, [wallet]), `Minting wallet (${shortAddress})`);
  assert.equal(getHoldingWalletLabel(address, [{ ...wallet, note: null }]), shortAddress);
  assert.equal(getHoldingWalletLabel(address, []), shortAddress);
});
