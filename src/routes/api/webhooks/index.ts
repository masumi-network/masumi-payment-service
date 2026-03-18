import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { Network } from '@/generated/prisma/client';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import {
	deleteWebhookSchemaInput,
	deleteWebhookSchemaOutput,
	listWebhooksSchemaInput,
	listWebhooksSchemaOutput,
	registerWebhookSchemaInput,
	registerWebhookSchemaOutput,
} from './schemas';

export {
	deleteWebhookSchemaInput,
	deleteWebhookSchemaOutput,
	listWebhooksSchemaInput,
	listWebhooksSchemaOutput,
	registerWebhookSchemaInput,
	registerWebhookSchemaOutput,
};

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

			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, paymentSource.network);
		} else {
			for (const network of Object.values(Network)) {
				await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, network);
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
				events: input.Events,
				name: input.name,
				paymentSourceId: input.paymentSourceId,
				createdByApiKeyId: ctx.id, // Track who created this webhook
				isActive: true,
			},
		});

		return {
			id: webhook.id,
			url: webhook.url,
			Events: webhook.events,
			name: webhook.name,
			isActive: webhook.isActive,
			createdAt: webhook.createdAt,
			paymentSourceId: webhook.paymentSourceId,
		};
	},
});

export const listWebhooksGet = payAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listWebhooksSchemaInput,
	output: listWebhooksSchemaOutput,
	handler: async ({ input, ctx }) => {
		const webhooks = await prisma.webhookEndpoint.findMany({
			where: {
				PaymentSource: {
					network: ctx.canAdmin ? undefined : { in: ctx.networkLimit },
					deletedAt: null,
					...(input.paymentSourceId ? { id: input.paymentSourceId } : {}),
				},
				// Only show webhooks created by this API key, unless user is admin
				...(ctx.canAdmin ? {} : { createdByApiKeyId: ctx.id }),
			},
			include: {
				CreatedByApiKey: {
					select: {
						id: true,
						token: true,
					},
				},
			},
			orderBy: { createdAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
		});

		return {
			Webhooks: webhooks.map((webhook) => ({
				id: webhook.id,
				url: webhook.url,
				Events: webhook.events,
				name: webhook.name,
				isActive: webhook.isActive,
				createdAt: webhook.createdAt,
				updatedAt: webhook.updatedAt,
				paymentSourceId: webhook.paymentSourceId,
				failureCount: webhook.failureCount,
				lastSuccessAt: webhook.lastSuccessAt,
				disabledAt: webhook.disabledAt,
				CreatedBy: webhook.CreatedByApiKey
					? {
							apiKeyId: webhook.CreatedByApiKey.id,
							apiKeyToken: webhook.CreatedByApiKey.token,
						}
					: null,
			})),
		};
	},
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
		const isAdmin = ctx.canAdmin;

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
