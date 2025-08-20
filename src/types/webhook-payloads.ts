import { WebhookEventType } from '@prisma/client';
import { z } from 'zod';
import { queryPurchaseRequestSchemaOutput } from '@/routes/api/purchases';
import { queryPaymentsSchemaOutput } from '@/routes/api/payments';

// Base webhook payload structure
export interface BaseWebhookPayload {
  event_type: WebhookEventType;
  timestamp: string;
  webhook_id: string;
  data: Record<string, unknown>;
}

// Extract individual purchase/payment item types from existing API schemas
type PurchaseItem = z.infer<
  typeof queryPurchaseRequestSchemaOutput
>['Purchases'][0];
type PaymentItem = z.infer<typeof queryPaymentsSchemaOutput>['Payments'][0];

interface WebhookPayloadWithData<
  T extends WebhookEventType,
  TData extends Record<string, unknown>,
> extends BaseWebhookPayload {
  event_type: T;
  data: TData;
}

// PURCHASE webhooks
export type PurchaseOnChainStatusChangedPayload = WebhookPayloadWithData<
  'PURCHASE_ON_CHAIN_STATUS_CHANGED',
  PurchaseItem
>;
export type PurchaseOnErrorPayload = WebhookPayloadWithData<
  'PURCHASE_ON_ERROR',
  PurchaseItem
>;

// PAYMENT webhooks
export type PaymentOnChainStatusChangedPayload = WebhookPayloadWithData<
  'PAYMENT_ON_CHAIN_STATUS_CHANGED',
  PaymentItem
>;
export type PaymentOnErrorPayload = WebhookPayloadWithData<
  'PAYMENT_ON_ERROR',
  PaymentItem
>;

// Union type for all webhook payloads
export type WebhookPayload =
  | PurchaseOnChainStatusChangedPayload
  | PaymentOnChainStatusChangedPayload
  | PurchaseOnErrorPayload
  | PaymentOnErrorPayload;

export const WEBHOOK_EVENT_VALUES = {
  PURCHASE_ON_CHAIN_STATUS_CHANGED: 'PURCHASE_ON_CHAIN_STATUS_CHANGED' as const,
  PAYMENT_ON_CHAIN_STATUS_CHANGED: 'PAYMENT_ON_CHAIN_STATUS_CHANGED' as const,
  PURCHASE_ON_ERROR: 'PURCHASE_ON_ERROR' as const,
  PAYMENT_ON_ERROR: 'PAYMENT_ON_ERROR' as const,
} as const;
