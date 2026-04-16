import { Network, WebhookEventType, WebhookFormat } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

export const registerWebhookSchemaInput = z
	.object({
		url: z
			.string()
			.url()
			.max(500)
			.describe('The webhook URL to receive notifications. Only public http and https destinations are allowed.'),
		authToken: z
			.string()
			.min(10)
			.max(200)
			.optional()
			.nullable()
			.describe('Authentication token for extended webhook requests. Required when format is EXTENDED'),
		format: z
			.nativeEnum(WebhookFormat)
			.default(WebhookFormat.EXTENDED)
			.describe('Webhook delivery format. Defaults to EXTENDED'),
		Events: z.array(z.nativeEnum(WebhookEventType)).min(1).max(10).describe('Array of event types to subscribe to'),
		name: z.string().max(100).optional().describe('Human-readable name for the webhook'),
		paymentSourceId: z.string().optional().nullable().describe('Optional: link webhook to specific payment source'),
	})
	.superRefine((value, ctx) => {
		if (value.format === WebhookFormat.EXTENDED && value.authToken == null) {
			ctx.addIssue({
				code: 'custom',
				path: ['authToken'],
				message: 'authToken is required when format is EXTENDED',
			});
		}
	});

export const patchWebhookSchemaInput = z
	.object({
		webhookId: z.string().describe('The ID of the webhook to update'),
		url: z
			.string()
			.url()
			.max(500)
			.describe('The webhook URL to receive notifications. Only public http and https destinations are allowed.'),
		authToken: z
			.string()
			.min(10)
			.max(200)
			.optional()
			.nullable()
			.describe('Authentication token for extended webhook requests. Required when format is EXTENDED'),
		format: z.nativeEnum(WebhookFormat).describe('Webhook delivery format'),
		Events: z.array(z.nativeEnum(WebhookEventType)).min(1).max(10).describe('Array of event types to subscribe to'),
		name: z.string().max(100).optional().nullable().describe('Human-readable name for the webhook'),
	})
	.superRefine((value, ctx) => {
		if (value.format === WebhookFormat.EXTENDED && value.authToken == null) {
			ctx.addIssue({
				code: 'custom',
				path: ['authToken'],
				message: 'authToken is required when format is EXTENDED',
			});
		}
	});

export const registerWebhookSchemaOutput = z.object({
	id: z.string(),
	url: z.string(),
	format: z.nativeEnum(WebhookFormat),
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
			format: z.nativeEnum(WebhookFormat),
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
					apiKeyToken: z.string().nullable(),
				})
				.nullable(),
		}),
	),
});

export const patchWebhookSchemaOutput = z.object({
	id: z.string(),
	url: z.string(),
	format: z.nativeEnum(WebhookFormat),
	Events: z.array(z.nativeEnum(WebhookEventType)),
	name: z.string().nullable(),
	isActive: z.boolean(),
	createdAt: z.date(),
	updatedAt: z.date(),
	paymentSourceId: z.string().nullable(),
});

export const deleteWebhookSchemaInput = z.object({
	webhookId: z.string().describe('The ID of the webhook to delete'),
});

export const testWebhookSchemaInput = z.object({
	webhookId: z.string().describe('The ID of the webhook to send a test delivery to'),
});

export const testWebhookSchemaOutput = z.object({
	webhookId: z.string(),
	success: z.boolean(),
	responseCode: z
		.number()
		.nullable()
		.describe('Always null for test deliveries to avoid exposing upstream response details.'),
	errorMessage: z.string().nullable().describe('Null on success, otherwise a coarse delivery status message.'),
	durationMs: z.number().describe('Always 0 for test deliveries to avoid exposing timing details.'),
});

export const deleteWebhookSchemaOutput = z.object({
	id: z.string(),
	url: z.string(),
	name: z.string().nullable(),
	deletedAt: z.date(),
});

export const registerWebhookForAllNetworksExample = Object.values(Network);
