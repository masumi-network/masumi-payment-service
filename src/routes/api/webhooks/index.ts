import { payAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { Network, WebhookFormat } from '@/generated/prisma/client';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth';
import {
	decryptWebhookUrlSafe,
	encryptWebhookAuthToken,
	encryptWebhookUrl,
	generateWebhookUrlHash,
} from '@/utils/security/webhook-secrets';
import { CONFIG } from '@masumi/payment-core/config';
import { webhookSenderService } from '@/services/webhooks/sender.service';
import { createAuthenticatedRateLimitMiddleware } from '@/utils/middleware/rate-limit';
import {
	assertWebhookDestinationAllowed,
	isWebhookDestinationPolicyError,
	WEBHOOK_DELIVERY_BLOCKED_MESSAGE,
	WEBHOOK_DESTINATION_NOT_ALLOWED_MESSAGE,
} from '@/utils/security/webhook-destination-policy';
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

const webhookMutationEndpointFactory = payAuthenticatedEndpointFactory.addMiddleware(
	createAuthenticatedRateLimitMiddleware({
		maxRequests: 30,
		windowMs: 60_000,
	}),
);

const webhookTestEndpointFactory = payAuthenticatedEndpointFactory.addMiddleware(
	createAuthenticatedRateLimitMiddleware({
		maxRequests: 10,
		windowMs: 60_000,
	}),
);

const ensureWebhookDestinationAllowed = async (url: string): Promise<void> => {
	try {
		await assertWebhookDestinationAllowed(url);
	} catch (error) {
		if (isWebhookDestinationPolicyError(error)) {
			throw createHttpError(400, WEBHOOK_DESTINATION_NOT_ALLOWED_MESSAGE);
		}
		throw error;
	}
};

const getCoarseWebhookTestErrorMessage = (errorMessage?: string): string => {
	if (errorMessage === WEBHOOK_DELIVERY_BLOCKED_MESSAGE) {
		return WEBHOOK_DELIVERY_BLOCKED_MESSAGE;
	}

	return 'Delivery failed';
};

export const registerWebhookPost = webhookMutationEndpointFactory.build({
	method: 'post',
	input: registerWebhookSchemaInput,
	output: registerWebhookSchemaOutput,
	handler: async ({ input, ctx }) => {
		await ensureWebhookDestinationAllowed(input.url);
		const urlHash = generateWebhookUrlHash(input.url);

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

		// Checking if webhook URL already exist for this payment source.
		// `?? null` is required: when paymentSourceId is undefined (a global
		// webhook) Prisma drops the key from the filter, which would match a
		// webhook on ANY source and raise a false 409. Coercing to null scopes
		// the check to global webhooks only.
		const existingWebhook = await prisma.webhookEndpoint.findFirst({
			where: {
				urlHash,
				paymentSourceId: input.paymentSourceId ?? null,
				format: input.format,
			},
		});

		if (existingWebhook) {
			throw createHttpError(409, 'Webhook URL already registered for this payment source');
		}

		// Create webhook endpoint with creator tracking
		const webhook = await prisma.webhookEndpoint.create({
			data: {
				url: encryptWebhookUrl(input.url),
				urlHash,
				authToken: input.format === WebhookFormat.EXTENDED ? encryptWebhookAuthToken(input.authToken) : null,
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
			url: input.url,
			format: webhook.format,
			Events: webhook.events,
			name: webhook.name,
			isActive: webhook.isActive,
			createdAt: webhook.createdAt,
			paymentSourceId: webhook.paymentSourceId,
		};
	},
});

export const patchWebhookPatch = webhookMutationEndpointFactory.build({
	method: 'patch',
	input: patchWebhookSchemaInput,
	output: patchWebhookSchemaOutput,
	handler: async ({ input, ctx }) => {
		await ensureWebhookDestinationAllowed(input.url);
		const urlHash = generateWebhookUrlHash(input.url);

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
				urlHash,
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
				url: encryptWebhookUrl(input.url),
				urlHash,
				authToken: input.format === WebhookFormat.EXTENDED ? encryptWebhookAuthToken(input.authToken) : null,
				format: input.format,
				events: input.Events,
				name: input.name ?? null,
			},
		});

		return {
			id: updatedWebhook.id,
			url: input.url,
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
				// Only show webhooks created by this API key, unless user is admin
				...(ctx.canAdmin ? {} : { createdByApiKeyId: ctx.id }),
				...(input.paymentSourceId
					? {
							paymentSourceId: input.paymentSourceId,
							PaymentSource: {
								network: ctx.canAdmin ? undefined : { in: ctx.networkLimit },
								deletedAt: null,
							},
						}
					: {
							// Global webhooks have a null paymentSourceId; a bare relation
							// filter drops null-relation rows and hid every global webhook
							// from this list. Include them alongside source-scoped ones.
							OR: [
								{ paymentSourceId: null },
								{
									PaymentSource: {
										network: ctx.canAdmin ? undefined : { in: ctx.networkLimit },
										deletedAt: null,
									},
								},
							],
						}),
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
				url: decryptWebhookUrlSafe(webhook.url),
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
							// Return the pre-masked stored token form (`*****xxxx`), never the
							// decrypted plaintext — a list response (or response-logging
							// middleware) must not leak every creator's full API key. Mirrors
							// the masking policy documented in the api-key serializer.
							apiKeyToken: webhook.CreatedByApiKey.token ?? '*****',
							apiKeyId: webhook.CreatedByApiKey.id,
						}
					: null,
			})),
		};
	},
});

export const deleteWebhookDelete = webhookMutationEndpointFactory.build({
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
			url: decryptWebhookUrlSafe(webhook.url),
			name: webhook.name,
			deletedAt: new Date(),
		};
	},
});

export const testWebhookPost = webhookTestEndpointFactory.build({
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
			responseCode: null,
			errorMessage: result.success ? null : getCoarseWebhookTestErrorMessage(result.errorMessage),
			durationMs: 0,
		};
	},
});
