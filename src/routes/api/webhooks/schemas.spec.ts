import { describe, expect, it } from '@jest/globals';
import { WebhookEventType, WebhookFormat } from '@/generated/prisma/client';
import { patchWebhookSchemaInput, registerWebhookSchemaInput } from './schemas';

// The create dialog subscribes to every event of a rail by default. A fixed cap
// of ten fell behind the enum, and the default request came back 400.
describe('webhook event subscriptions', () => {
	const everyEvent = Object.values(WebhookEventType);

	it('accepts a webhook subscribed to every event', () => {
		expect(
			registerWebhookSchemaInput.safeParse({
				url: 'https://example.com/hook',
				format: WebhookFormat.SLACK,
				Events: everyEvent,
			}).success,
		).toBe(true);
		expect(
			patchWebhookSchemaInput.safeParse({
				webhookId: 'webhook-1',
				url: 'https://example.com/hook',
				format: WebhookFormat.SLACK,
				Events: everyEvent,
			}).success,
		).toBe(true);
	});
});
