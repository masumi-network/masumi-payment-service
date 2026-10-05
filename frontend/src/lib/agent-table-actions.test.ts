import assert from 'node:assert/strict';
import test from 'node:test';
import type { RegistryEntry } from '@/lib/api/generated';
import { isBulkDeletableAgent, isBulkDeregisterableAgent } from './agent-table-actions';

test('bulk actions retain permissions, ownership, state and identifier checks', () => {
  const failed = { state: 'RegistrationFailed' } as RegistryEntry;
  const minted = { state: 'RegistrationConfirmed', agentIdentifier: 'asset' } as RegistryEntry;
  assert.equal(isBulkDeletableAgent(failed, true), true);
  assert.equal(isBulkDeletableAgent(failed, false), false);
  assert.equal(isBulkDeletableAgent({ ...failed, relation: 'payment' }, true), false);
  assert.equal(isBulkDeregisterableAgent(minted, true), true);
  assert.equal(isBulkDeregisterableAgent(minted, false), false);
  assert.equal(isBulkDeregisterableAgent({ ...minted, agentIdentifier: '' }, true), false);
  assert.equal(isBulkDeregisterableAgent({ ...minted, relation: 'payment' }, true), false);
  assert.equal(isBulkDeregisterableAgent(failed, true), false);
});
