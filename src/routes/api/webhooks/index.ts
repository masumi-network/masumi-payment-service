import { payAuthenticatedEndpointFactory } from '@/utils/security/auth/pay-authenticated';
import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { WebhookEventType } from '@prisma/client';

// Schema for registering a new webhook
export const registerWebhookSchemaInput = z.object({
  url: z
    .string()
    .url()
    .max(500)
    .describe('The webhook URL to receive notifications'),
  authToken: z
    .string()
    .min(10)
    .max(200)
    .describe('Authentication token for webhook requests'),
  events: z
    .array(z.nativeEnum(WebhookEventType))
    .min(1)
    .max(10)
    .describe('Array of event types to subscribe to'),
  name: z
    .string()
    .max(100)
    .optional()
    .describe('Human-readable name for the webhook'),
  paymentSourceId: z
    .string()
    .optional()
    .nullable()
    .describe('Optional: link webhook to specific payment source'),
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
  handler: async ({ input, options }) => {
    if (input.paymentSourceId) {
      const paymentSource = await prisma.paymentSource.findUnique({
        where: { id: input.paymentSourceId, deletedAt: null },
      });
      if (!paymentSource) {
        throw createHttpError(404, 'Payment source not found');
      }
    }

    // Checking if webhook URLL alraedy exist for this payment source
    const existingWebhook = await prisma.webhookEndpoint.findFirst({
      where: {
        url: input.url,
        paymentSourceId: input.paymentSourceId,
      },
    });

    if (existingWebhook) {
      throw createHttpError(
        409,
        'Webhook URL already registered for this payment source',
      );
    }

    // Create webhook endpoint with creator tracking
    const webhook = await prisma.webhookEndpoint.create({
      data: {
        url: input.url,
        authToken: input.authToken,
        events: input.events,
        name: input.name,
        paymentSourceId: input.paymentSourceId,
        createdByApiKeyId: options.id, // Track who created this webhook
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
  paymentSourceId: z
    .string()
    .optional()
    .nullable()
    .describe('Filter by payment source ID'),
  limit: z
    .number({ coerce: true })
    .min(1)
    .max(50)
    .default(10)
    .describe('Number of webhooks to return'),
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

export const listWebhooksGet = adminAuthenticatedEndpointFactory.build({
  method: 'get',
  input: listWebhooksSchemaInput,
  output: listWebhooksSchemaOutput,
  handler: async ({
    input,
  }: {
    input: z.infer<typeof listWebhooksSchemaInput>;
  }) => {
    const webhooks = await prisma.webhookEndpoint.findMany({
      where: {
        paymentSourceId: input.paymentSourceId || undefined,
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
