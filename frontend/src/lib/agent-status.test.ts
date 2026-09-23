import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getAgentIdentifierPlaceholder,
  getAgentStatusHelperText,
  parseAgentStatus,
  parseInboxAgentStatus,
} from './agent-status';

test('parseInboxAgentStatus maps update lifecycle states', () => {
  assert.equal(parseInboxAgentStatus('UpdateRequested'), 'Update pending');
  assert.equal(parseInboxAgentStatus('UpdateInitiated'), 'Updating');
});

test('parseAgentStatus distinguishes pending registry operations', () => {
  assert.equal(parseAgentStatus('RegistrationRequested'), 'Registering');
  assert.equal(parseAgentStatus('UpdateRequested'), 'Update pending');
  assert.equal(parseAgentStatus('DeregistrationRequested'), 'Deregistration pending');
});

test('getAgentStatusHelperText only covers requested states', () => {
  assert.match(getAgentStatusHelperText('RegistrationRequested') ?? '', /queued/i);
  assert.match(getAgentStatusHelperText('UpdateRequested') ?? '', /update/i);
  assert.match(getAgentStatusHelperText('DeregistrationRequested') ?? '', /deregistration/i);
  assert.equal(getAgentStatusHelperText('RegistrationConfirmed'), null);
});

test('getAgentIdentifierPlaceholder explains missing identifiers', () => {
  assert.equal(getAgentIdentifierPlaceholder('RegistrationRequested'), 'Minting on-chain…');
  assert.equal(getAgentIdentifierPlaceholder('UpdateRequested'), 'Updating on-chain…');
  assert.equal(getAgentIdentifierPlaceholder('RegistrationConfirmed'), '—');
});
