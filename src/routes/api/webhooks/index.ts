import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { Network, WebhookFormat } from '@/generated/prisma/client';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@/utils/middleware/auth-middleware';
import { decrypt } from '@/utils/security/encryption';
import { logger } from '@/utils/logger';
import { CONFIG } from '@/utils/config';
import { webhookSenderService } from '@/services/webhooks/sender.service';
import {
	deleteWebhookSchemaInput,
	deleteWebhookSchemaOutput,
	listWebhooksSchemaInput,
	listWebhooksSchemaOutput,
	patchWebhookSchemaInput,
	patchWebhookSchemaOutput,
	registerWebhookSchemaInput,
	registerWebhookSchemaOutput,
	testWebhookSchemaInput,
	testWebhookSchemaOutput,
} from './schemas';

export {
	deleteWebhookSchemaInput,
	deleteWebhookSchemaOutput,
	listWebhooksSchemaInput,
	listWebhooksSchemaOutput,
	patchWebhookSchemaInput,
	patchWebhookSchemaOutput,
	registerWebhookSchemaInput,
	registerWebhookSchemaOutput,
	testWebhookSchemaInput,
	testWebhookSchemaOutput,
};

const decryptApiKeyTokenSafe = (encryptedToken: string | null): string | null => {
	if (!encryptedToken) return null;
	try {
		return decrypt(encryptedToken);
	} catch (e) {
		logger.error('Failed to decrypt API key token for webhook CreatedBy field', { error: e });
		return null;
	}
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
				format: input.format,
			},
		});

		if (existingWebhook) {
			throw createHttpError(409, 'Webhook URL already registered for this payment source');
		}

		// Create webhook endpoint with creator tracking
		const webhook = await prisma.webhookEndpoint.create({
			data: {
				url: input.url,
				authToken: input.format === WebhookFormat.EXTENDED ? input.authToken : null,
				format: input.format,
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
			format: webhook.format,
			Events: webhook.events,
			name: webhook.name,
			isActive: webhook.isActive,
			createdAt: webhook.createdAt,
			paymentSourceId: webhook.paymentSourceId,
		};
	},
});

export const patchWebhookPatch = payAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: patchWebhookSchemaInput,
	output: patchWebhookSchemaOutput,
	handler: async ({ input, ctx }) => {
		const webhook = await prisma.webhookEndpoint.findUnique({
			where: { id: input.webhookId },
			include: {
				PaymentSource: {
					select: {
						id: true,
						network: true,
						deletedAt: true,
					},
				},
			},
		});

		if (!webhook) {
			throw createHttpError(404, 'Webhook not found');
		}

		const isCreator = webhook.createdByApiKeyId === ctx.id;
		const isAdmin = ctx.canAdmin;

		if (!isCreator && !isAdmin) {
			throw createHttpError(403, 'Unauthorized: Only the creator or an admin can update this webhook');
		}

		if (webhook.paymentSourceId && webhook.PaymentSource) {
			if (webhook.PaymentSource.deletedAt != null) {
				throw createHttpError(404, 'Payment source not found');
			}
			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, webhook.PaymentSource.network);
		} else {
			for (const network of Object.values(Network)) {
				await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, network);
			}
		}

		const existingWebhook = await prisma.webhookEndpoint.findFirst({
			where: {
				id: { not: input.webhookId },
				url: input.url,
				paymentSourceId: webhook.paymentSourceId,
				format: input.format,
			},
		});

		if (existingWebhook) {
			throw createHttpError(409, 'Webhook URL already registered for this payment source');
		}

		const updatedWebhook = await prisma.webhookEndpoint.update({
			where: { id: input.webhookId },
			data: {
				url: input.url,
				authToken: input.format === WebhookFormat.EXTENDED ? input.authToken : null,
				format: input.format,
				events: input.Events,
				name: input.name ?? null,
			},
		});

		return {
			id: updatedWebhook.id,
			url: updatedWebhook.url,
			format: updatedWebhook.format,
			Events: updatedWebhook.events,
			name: updatedWebhook.name,
			isActive: updatedWebhook.isActive,
			createdAt: updatedWebhook.createdAt,
			updatedAt: updatedWebhook.updatedAt,
			paymentSourceId: updatedWebhook.paymentSourceId,
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
						encryptedToken: true,
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
				format: webhook.format,
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
							apiKeyToken: decryptApiKeyTokenSafe(webhook.CreatedByApiKey.encryptedToken),
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

export const testWebhookPost = payAuthenticatedEndpointFactory.build({
	method: 'post',
	input: testWebhookSchemaInput,
	output: testWebhookSchemaOutput,
	handler: async ({ input, ctx }) => {
		const webhook = await prisma.webhookEndpoint.findUnique({
			where: { id: input.webhookId },
			include: {
				PaymentSource: {
					select: {
						id: true,
						network: true,
						deletedAt: true,
					},
				},
			},
		});

		if (!webhook) {
			throw createHttpError(404, 'Webhook not found');
		}

		const isCreator = webhook.createdByApiKeyId === ctx.id;
		const isAdmin = ctx.canAdmin;

		if (!isCreator && !isAdmin) {
			throw createHttpError(403, 'Unauthorized: Only the creator or an admin can test this webhook');
		}

		if (webhook.paymentSourceId && webhook.PaymentSource) {
			if (webhook.PaymentSource.deletedAt != null) {
				throw createHttpError(404, 'Payment source not found');
			}

			await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, webhook.PaymentSource.network);
		}

		const result = await webhookSenderService.sendTestWebhook(
			{
				id: webhook.id,
				url: webhook.url,
				format: webhook.format,
				authToken: webhook.authToken,
				name: webhook.name,
				paymentSourceId: webhook.paymentSourceId,
			},
			ctx.id,
			CONFIG.OTEL_SERVICE_NAME,
		);

		return {
			webhookId: webhook.id,
			success: result.success,
			responseCode: result.responseCode ?? null,
			errorMessage: result.errorMessage ?? null,
			durationMs: result.durationMs,
		};
	},
});
