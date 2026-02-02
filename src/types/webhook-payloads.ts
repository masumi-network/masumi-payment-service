import { WebhookEventType } from '@/generated/prisma/client';
import { z } from 'zod';
import { queryPurchaseRequestSchemaOutput } from '@/routes/api/purchases';
import { queryPaymentsSchemaOutput } from '@/routes/api/payments';

// Base webhook payload schema
export const baseWebhookPayloadSchema = z.object({
	event_type: z.nativeEnum(WebhookEventType).describe('The type of webhook event that occurred'),
	timestamp: z.string().datetime().describe('ISO 8601 timestamp when the webhook was triggered'),
	webhook_id: z.string().describe('Unique identifier for this webhook delivery'),
	data: z.record(z.string(), z.unknown()).describe('The actual data payload for the webhook event'),
});

// Extract individual purchase/payment item schemas from existing API schemas
const purchaseItemSchema = queryPurchaseRequestSchemaOutput.shape.Purchases.element;
const paymentItemSchema = queryPaymentsSchemaOutput.shape.Payments.element;

// Generic webhook payload schema factory
const createWebhookPayloadSchema = <T extends z.ZodLiteral<WebhookEventType>>(
	eventType: T,
	dataSchema: z.ZodType,
	description: string,
) =>
	z.object({
		event_type: eventType.describe('The type of webhook event that occurred'),
		timestamp: z.string().datetime().describe('ISO 8601 timestamp when the webhook was triggered'),
		webhook_id: z.string().describe('Unique identifier for this webhook delivery'),
		data: dataSchema.describe(description),
	});

// PURCHASE webhook schemas
export const purchaseOnChainStatusChangedPayloadSchema = createWebhookPayloadSchema(
	z.literal('PURCHASE_ON_CHAIN_STATUS_CHANGED'),
	purchaseItemSchema,
	'Complete purchase data matching the GET /purchases endpoint structure when purchase on-chain status changes',
);

export const purchaseOnErrorPayloadSchema = createWebhookPayloadSchema(
	z.literal('PURCHASE_ON_ERROR'),
	purchaseItemSchema,
	'Complete purchase data matching the GET /purchases endpoint structure when purchase encounters an error',
);

// PAYMENT webhook schemas
export const paymentOnChainStatusChangedPayloadSchema = createWebhookPayloadSchema(
	z.literal('PAYMENT_ON_CHAIN_STATUS_CHANGED'),
	paymentItemSchema,
	'Complete payment data matching the GET /payments endpoint structure when payment on-chain status changes',
);

export const paymentOnErrorPayloadSchema = createWebhookPayloadSchema(
	z.literal('PAYMENT_ON_ERROR'),
	paymentItemSchema,
	'Complete payment data matching the GET /payments endpoint structure when payment encounters an error',
);

// Union schema for all webhook payloads
export const webhookPayloadSchema = z.discriminatedUnion('event_type', [
	purchaseOnChainStatusChangedPayloadSchema,
	paymentOnChainStatusChangedPayloadSchema,
	purchaseOnErrorPayloadSchema,
	paymentOnErrorPayloadSchema,
]);

// TypeScript types derived from schemas (for backward compatibility)
export type BaseWebhookPayload = z.infer<typeof baseWebhookPayloadSchema>;
export type PurchaseOnChainStatusChangedPayload = z.infer<typeof purchaseOnChainStatusChangedPayloadSchema>;
export type PurchaseOnErrorPayload = z.infer<typeof purchaseOnErrorPayloadSchema>;
export type PaymentOnChainStatusChangedPayload = z.infer<typeof paymentOnChainStatusChangedPayloadSchema>;
export type PaymentOnErrorPayload = z.infer<typeof paymentOnErrorPayloadSchema>;
export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export const WEBHOOK_EVENT_VALUES = {
	PURCHASE_ON_CHAIN_STATUS_CHANGED: 'PURCHASE_ON_CHAIN_STATUS_CHANGED' as const,
	PAYMENT_ON_CHAIN_STATUS_CHANGED: 'PAYMENT_ON_CHAIN_STATUS_CHANGED' as const,
	PURCHASE_ON_ERROR: 'PURCHASE_ON_ERROR' as const,
	PAYMENT_ON_ERROR: 'PAYMENT_ON_ERROR' as const,
} as const;
