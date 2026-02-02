import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { WebhookEventType, Permission, Network } from '@/generated/prisma/client';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';

// Schema for registering a new webhook
export const registerWebhookSchemaInput = z.object({
	url: z.string().url().max(500).describe('The webhook URL to receive notifications'),
	authToken: z.string().min(10).max(200).describe('Authentication token for webhook requests'),
	events: z.array(z.nativeEnum(WebhookEventType)).min(1).max(10).describe('Array of event types to subscribe to'),
	name: z.string().max(100).optional().describe('Human-readable name for the webhook'),
	paymentSourceId: z.string().optional().nullable().describe('Optional: link webhook to specific payment source'),
});

export const registerWebhookSchemaOutput = z.object({
	id: z.string(),
	url: z.string(),
	events: z.array(z.nativeEnum(WebhookEventType)),
	name: z.string().nullable(),
	isActive: z.boolean(),
	createdAt: z.date(),
	paymentSourceId: z.string().nullable(),
});

export const registerWebhookPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: registerWebhookSchemaInput,
	output: registerWebhookSchemaOutput,
	handler: async ({ input, ctx }) => {
		if (input.paymentSourceId) {
			const paymentSource = await prisma.paymentSource.findUnique({
				where: { id: input.paymentSourceId, deletedAt: null },
			});
			if (!paymentSource) {
				throw createHttpError(404, 'Payment source not found');
			}

			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, paymentSource.network, ctx.permission);
		} else {
			for (const network of Object.values(Network)) {
				await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, network, ctx.permission);
			}
		}

		// Checking if webhook URL already exist for this payment source
		const existingWebhook = await prisma.webhookEndpoint.findFirst({
			where: {
				url: input.url,
				paymentSourceId: input.paymentSourceId,
			},
		});

		if (existingWebhook) {
			throw createHttpError(409, 'Webhook URL already registered for this payment source');
		}

		// Create webhook endpoint with creator tracking
		const webhook = await prisma.webhookEndpoint.create({
			data: {
				url: input.url,
				authToken: input.authToken,
				events: input.events,
				name: input.name,
				paymentSourceId: input.paymentSourceId,
				createdByApiKeyId: ctx.id, // Track who created this webhook
				isActive: true,
			},
		});

		return {
			id: webhook.id,
			url: webhook.url,
			events: webhook.events,
			name: webhook.name,
			isActive: webhook.isActive,
			createdAt: webhook.createdAt,
			paymentSourceId: webhook.paymentSourceId,
		};
	},
});

// Schema for listing webhooks
export const listWebhooksSchemaInput = z.object({
	paymentSourceId: z.string().optional().nullable().describe('Filter by payment source ID'),
	cursorId: z.string().optional().describe('Cursor ID to paginate through the results'),
	limit: z.coerce.number().min(1).max(50).default(10).describe('Number of webhooks to return'),
});

export const listWebhooksSchemaOutput = z.object({
	webhooks: z.array(
		z.object({
			id: z.string(),
			url: z.string(),
			events: z.array(z.nativeEnum(WebhookEventType)),
			name: z.string().nullable(),
			isActive: z.boolean(),
			createdAt: z.date(),
			updatedAt: z.date(),
			paymentSourceId: z.string().nullable(),
			failureCount: z.number(),
			lastSuccessAt: z.date().nullable(),
			disabledAt: z.date().nullable(),
			createdBy: z
				.object({
					apiKeyId: z.string(),
					apiKeyToken: z.string(),
				})
				.nullable(),
		}),
	),
});

export const listWebhooksGet = payAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listWebhooksSchemaInput,
	output: listWebhooksSchemaOutput,
	handler: async ({ input, ctx }) => {
		const webhooks = await prisma.webhookEndpoint.findMany({
			where: {
				PaymentSource: {
					network: ctx.permission === Permission.Admin ? undefined : { in: ctx.networkLimit },
					deletedAt: null,
					...(input.paymentSourceId ? { id: input.paymentSourceId } : {}),
				},
				// Only show webhooks created by this API key, unless user is admin
				...(ctx.permission === Permission.Admin ? {} : { createdByApiKeyId: ctx.id }),
			},
			include: {
				CreatedByApiKey: {
					select: {
						id: true,
						token: true, // For display purposes (safe to show)
					},
				},
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
		});

		return {
			webhooks: webhooks.map((webhook) => ({
				id: webhook.id,
				url: webhook.url,
				events: webhook.events,
				name: webhook.name,
				isActive: webhook.isActive,
				createdAt: webhook.createdAt,
				updatedAt: webhook.updatedAt,
				paymentSourceId: webhook.paymentSourceId,
				failureCount: webhook.failureCount,
				lastSuccessAt: webhook.lastSuccessAt,
				disabledAt: webhook.disabledAt,
				createdBy: webhook.CreatedByApiKey
					? {
							apiKeyId: webhook.CreatedByApiKey.id,
							apiKeyToken: webhook.CreatedByApiKey.token,
						}
					: null,
			})),
		};
	},
});

// Schema for deleting a webhook
export const deleteWebhookSchemaInput = z.object({
	webhookId: z.string().describe('The ID of the webhook to delete'),
});

export const deleteWebhookSchemaOutput = z.object({
	id: z.string(),
	url: z.string(),
	name: z.string().nullable(),
	deletedAt: z.date(),
});

export const deleteWebhookDelete = payAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteWebhookSchemaInput,
	output: deleteWebhookSchemaOutput,
	handler: async ({ input, ctx }) => {
		const webhook = await prisma.webhookEndpoint.findUnique({
			where: { id: input.webhookId },
			include: {
				CreatedByApiKey: {
					select: {
						id: true,
					},
				},
			},
		});

		if (!webhook) {
			throw createHttpError(404, 'Webhook not found');
		}

		// Authorization check: Only creator or admin can delete
		const isCreator = webhook.createdByApiKeyId === ctx.id;
		const isAdmin = ctx.permission === Permission.Admin;

		if (!isCreator && !isAdmin) {
			throw createHttpError(403, 'Unauthorized: Only the creator or an admin can delete this webhook');
		}

		// Delete the webhook
		await prisma.webhookEndpoint.delete({
			where: { id: input.webhookId },
		});

		return {
			id: webhook.id,
			url: webhook.url,
			name: webhook.name,
			deletedAt: new Date(),
		};
	},
});
