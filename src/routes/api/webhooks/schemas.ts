import { Network, WebhookEventType } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

export const registerWebhookSchemaInput = z.object({
	url: z.string().url().max(500).describe('The webhook URL to receive notifications'),
	authToken: z.string().min(10).max(200).describe('Authentication token for webhook requests'),
	Events: z.array(z.nativeEnum(WebhookEventType)).min(1).max(10).describe('Array of event types to subscribe to'),
	name: z.string().max(100).optional().describe('Human-readable name for the webhook'),
	paymentSourceId: z.string().optional().nullable().describe('Optional: link webhook to specific payment source'),
});

export const registerWebhookSchemaOutput = z.object({
	id: z.string(),
	url: z.string(),
	Events: z.array(z.nativeEnum(WebhookEventType)),
	name: z.string().nullable(),
	isActive: z.boolean(),
	createdAt: z.date(),
	paymentSourceId: z.string().nullable(),
});

export const listWebhooksSchemaInput = z.object({
	paymentSourceId: z.string().optional().nullable().describe('Filter by payment source ID'),
	cursorId: z.string().optional().describe('Cursor ID to paginate through the results'),
	limit: z.coerce.number().min(1).max(50).default(10).describe('Number of webhooks to return'),
});

export const listWebhooksSchemaOutput = z.object({
	Webhooks: z.array(
		z.object({
			id: z.string(),
			url: z.string(),
			Events: z.array(z.nativeEnum(WebhookEventType)),
			name: z.string().nullable(),
			isActive: z.boolean(),
			createdAt: z.date(),
			updatedAt: z.date(),
			paymentSourceId: z.string().nullable(),
			failureCount: z.number(),
			lastSuccessAt: z.date().nullable(),
			disabledAt: z.date().nullable(),
			CreatedBy: z
				.object({
					apiKeyId: z.string(),
					apiKeyToken: z.string(),
				})
				.nullable(),
		}),
	),
});

export const deleteWebhookSchemaInput = z.object({
	webhookId: z.string().describe('The ID of the webhook to delete'),
});

export const deleteWebhookSchemaOutput = z.object({
	id: z.string(),
	url: z.string(),
	name: z.string().nullable(),
	deletedAt: z.date(),
});

export const registerWebhookForAllNetworksExample = Object.values(Network);
