import assert from 'node:assert/strict';
import test from 'node:test';
import { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS, webhookEventsForRail } from './webhooks';

test('the Hydra contest watch alert can be selected for Cardano webhooks', () => {
  const event = 'HYDRA_HEAD_CONTEST_WATCH_ALERT';
  assert.ok((WEBHOOK_EVENTS as readonly string[]).includes(event));
  assert.ok((webhookEventsForRail('cardano') as readonly string[]).includes(event));
  assert.ok((WEBHOOK_EVENT_LABELS as Record<string, string>)[event]);
});
