import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInvitePreviewGate } from './invite-preview-gate';

test('a response stays current when nothing changed', () => {
  const gate = createInvitePreviewGate();
  const ticket = gate.begin('code-a');
  assert.equal(gate.isCurrent(ticket), true);
  assert.equal(ticket.code, 'code-a');
});

// The audit sequence: read A, edit the field to B while A is pending, then A's
// response arrives. It must be discarded, or A's terms would front B's redeem.
test('editing the code while a preview is pending discards that preview', () => {
  const gate = createInvitePreviewGate();
  const ticketA = gate.begin('code-a');
  gate.invalidate();
  assert.equal(gate.isCurrent(ticketA), false);
});

test('a newer preview request supersedes an older one', () => {
  const gate = createInvitePreviewGate();
  const ticketA = gate.begin('code-a');
  const ticketB = gate.begin('code-b');
  assert.equal(gate.isCurrent(ticketA), false);
  assert.equal(gate.isCurrent(ticketB), true);
  assert.equal(ticketB.code, 'code-b');
});
