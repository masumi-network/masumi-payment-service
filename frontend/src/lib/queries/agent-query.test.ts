import assert from 'node:assert/strict';
import test from 'node:test';
import type { PaymentSourceExtended, RegistryEntry } from '@/lib/api/generated';
import { buildAgentListQuery, collectAllAgentPages, resolveAgentListSource } from './agent-query';

function source(overrides: Partial<PaymentSourceExtended> = {}): PaymentSourceExtended {
  return {
    id: 'v2-source',
    network: 'Preprod',
    paymentSourceType: 'Web3CardanoV2',
    smartContractAddress: 'addr_test1_v2',
    ...overrides,
  } as PaymentSourceExtended;
}

test('does not pair a newly selected id with the previous source object', () => {
  assert.equal(resolveAgentListSource('v1-source', source(), 'Preprod'), null);
});

test('registry query is scoped by both source address and V1/V2 type', () => {
  const selectedSource = source({
    id: 'v1-source',
    paymentSourceType: 'Web3CardanoV1',
    smartContractAddress: 'addr_test1_v1',
  });

  assert.deepEqual(
    buildAgentListQuery(selectedSource, { filterStatus: 'Registered' }, 100, 'cursor-1'),
    {
      network: 'Preprod',
      cursorId: 'cursor-1',
      limit: 100,
      filterSmartContractAddress: 'addr_test1_v1',
      filterPaymentSourceType: 'Web3CardanoV1',
      filterStatus: 'Registered',
      searchQuery: undefined,
    },
  );
});

test('collects every inclusive cursor page without duplicating boundary rows', async () => {
  const pages = new Map<string | undefined, RegistryEntry[]>([
    [undefined, [{ id: 'agent-1' }, { id: 'agent-2' }] as RegistryEntry[]],
    ['agent-2', [{ id: 'agent-2' }, { id: 'agent-3' }] as RegistryEntry[]],
    ['agent-3', [{ id: 'agent-3' }] as RegistryEntry[]],
  ]);

  const result = await collectAllAgentPages(async (cursor) => pages.get(cursor) ?? [], 2);

  assert.deepEqual(
    result.map((agent) => agent.id),
    ['agent-1', 'agent-2', 'agent-3'],
  );
});

test('rejects the complete list when a later page fails instead of returning partial agents', async () => {
  await assert.rejects(
    collectAllAgentPages(async (cursor) => {
      if (cursor === undefined) {
        return [{ id: 'agent-1' }, { id: 'agent-2' }] as RegistryEntry[];
      }
      throw new Error('second page failed');
    }, 2),
    /second page failed/,
  );
});
