import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInvitePreviewGate } from './invite-preview-gate';

test('an accepted preview binds the code that redeem submits', () => {
  const gate = createInvitePreviewGate();
  const ticket = gate.begin('code-a');
  assert.equal(gate.accept(ticket), true);
  assert.equal(gate.acceptedCode(), 'code-a');
});

// The audit sequence: read A, edit the field to B while A is pending, then A's
// response arrives, then B is read. A must never become the redeemed code, and
// B's terms must be bound to B.
test('editing the code while a preview is pending discards that preview', () => {
  const gate = createInvitePreviewGate();
  const ticketA = gate.begin('code-a');
  gate.invalidate();
  assert.equal(gate.accept(ticketA), false);
  assert.equal(gate.acceptedCode(), null);

  const ticketB = gate.begin('code-b');
  assert.equal(gate.accept(ticketB), true);
  assert.equal(gate.acceptedCode(), 'code-b');
});

test('a newer preview request supersedes an older one', () => {
  const gate = createInvitePreviewGate();
  const ticketA = gate.begin('code-a');
  const ticketB = gate.begin('code-b');
  assert.equal(gate.accept(ticketA), false);
  assert.equal(gate.accept(ticketB), true);
  assert.equal(gate.acceptedCode(), 'code-b');
});

test('going back or closing unbinds the accepted code', () => {
  const gate = createInvitePreviewGate();
  gate.accept(gate.begin('code-a'));
  gate.invalidate();
  assert.equal(gate.acceptedCode(), null);
});
