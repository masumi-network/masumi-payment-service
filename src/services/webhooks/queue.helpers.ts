import { WebhookEventType } from '@/generated/prisma/client';
import type { WebhookPayloadByEvent, WebhookPayloadDataByEvent } from '@/types/webhook-payloads';
import {
	appendInclusiveCursorItems,
	getInclusiveCursorId,
	type InclusiveCursorItem,
} from '@/utils/pagination/inclusive-cursor';

export function buildWebhookPayload<TEventType extends WebhookEventType>(
	eventType: TEventType,
	payload: WebhookPayloadDataByEvent<TEventType>,
	timestamp = new Date().toISOString(),
): WebhookPayloadByEvent<TEventType> {
	return {
		event_type: eventType,
		timestamp,
		webhook_id: '',
		data: payload,
	} as WebhookPayloadByEvent<TEventType>;
}

export function buildEndpointWebhookPayload<TEventType extends WebhookEventType>(
	webhookPayload: WebhookPayloadByEvent<TEventType>,
	webhookId: string,
): WebhookPayloadByEvent<TEventType> {
	return {
		...webhookPayload,
		webhook_id: webhookId,
	} as WebhookPayloadByEvent<TEventType>;
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
