import { WebhookEventType } from '@/generated/prisma/client';
import {
	appendInclusiveCursorItems,
	getInclusiveCursorId,
	type InclusiveCursorItem,
} from '@/utils/pagination/inclusive-cursor';

export type WebhookPayload = {
	event_type: WebhookEventType;
	timestamp: string;
	webhook_id: string;
	data: Record<string, unknown>;
};

export function buildWebhookPayload(
	eventType: WebhookEventType,
	payload: Record<string, unknown>,
	timestamp = new Date().toISOString(),
): WebhookPayload {
	return {
		event_type: eventType,
		timestamp,
		webhook_id: '',
		data: payload,
	};
}

export function buildEndpointWebhookPayload(webhookPayload: WebhookPayload, webhookId: string): WebhookPayload {
	return {
		...webhookPayload,
		webhook_id: webhookId,
	};
}

export function mergeWebhookEndpointBatch<T extends InclusiveCursorItem>(
	existingEndpoints: readonly T[],
	nextPageEndpoints: readonly T[],
) {
	const mergedEndpoints = appendInclusiveCursorItems(existingEndpoints, nextPageEndpoints);
	const nextCursorId = getInclusiveCursorId(nextPageEndpoints);

	return {
		mergedEndpoints,
		nextCursorId,
		newEndpoints: mergedEndpoints.slice(existingEndpoints.length),
	};
}
