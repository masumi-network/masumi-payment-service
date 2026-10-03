import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAgentMetadataUpdateSupported,
  UNSUPPORTED_AGENT_UPDATE_MESSAGE,
} from './agent-update';

test('direct update guard stops unsupported agents before the submit callback', () => {
  for (const type of ['A2A', 'OpenApi', 'X402'] as const) {
    let submitted = false;
    assert.throws(
      () => {
        assertAgentMetadataUpdateSupported({ type });
        submitted = true;
      },
      { message: UNSUPPORTED_AGENT_UPDATE_MESSAGE },
    );
    assert.equal(submitted, false);
  }
  assert.doesNotThrow(() => assertAgentMetadataUpdateSupported({ type: 'Standard' }));
});
