import { HotWalletType, Network, WebhookEventType } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { queryPurchaseRequestSchemaOutput } from '@/routes/api/purchases';
import { queryPaymentsSchemaOutput } from '@/routes/api/payments';
import type { Jsonified } from '@/utils/json-value';
import { WEBHOOK_TEST_EVENT_TYPE } from './webhook-constants';

// Extract individual purchase/payment item schemas from existing API schemas
const purchaseItemSchema = queryPurchaseRequestSchemaOutput.shape.Purchases.element;
const paymentItemSchema = queryPaymentsSchemaOutput.shape.Payments.element;

// Generic webhook payload schema factory
const createWebhookPayloadSchema = <T extends z.ZodLiteral<WebhookEventType>, TDataSchema extends z.ZodTypeAny>(
	eventType: T,
	dataSchema: TDataSchema,
	description: string,
) =>
	z.object({
		event_type: eventType.describe('The type of webhook event that occurred'),
		service_name: z.string().describe('OpenTelemetry service name for the emitting Masumi service'),
		timestamp: z.string().datetime().describe('ISO 8601 timestamp when the webhook was triggered'),
		webhook_id: z.string().describe('Unique identifier for this webhook delivery'),
		data: dataSchema.describe(description),
	});

// PURCHASE webhook schemas
const purchaseOnChainStatusChangedPayloadSchema = createWebhookPayloadSchema(
	z.literal('PURCHASE_ON_CHAIN_STATUS_CHANGED'),
	purchaseItemSchema,
	'Complete purchase data matching the GET /purchases endpoint structure when purchase on-chain status changes',
);

const purchaseOnErrorPayloadSchema = createWebhookPayloadSchema(
	z.literal('PURCHASE_ON_ERROR'),
	purchaseItemSchema,
	'Complete purchase data matching the GET /purchases endpoint structure when purchase encounters an error',
);

// PAYMENT webhook schemas
const paymentOnChainStatusChangedPayloadSchema = createWebhookPayloadSchema(
	z.literal('PAYMENT_ON_CHAIN_STATUS_CHANGED'),
	paymentItemSchema,
	'Complete payment data matching the GET /payments endpoint structure when payment on-chain status changes',
);

const paymentOnErrorPayloadSchema = createWebhookPayloadSchema(
	z.literal('PAYMENT_ON_ERROR'),
	paymentItemSchema,
	'Complete payment data matching the GET /payments endpoint structure when payment encounters an error',
);

const walletLowBalancePayloadSchema = createWebhookPayloadSchema(
	z.literal('WALLET_LOW_BALANCE'),
	z.object({
		ruleId: z.string().describe('Low-balance rule id'),
		walletId: z.string().describe('Wallet id'),
		walletAddress: z.string().describe('Wallet address'),
		walletVkey: z.string().describe('Wallet verification key'),
		walletType: z.nativeEnum(HotWalletType).describe('Wallet type'),
		paymentSourceId: z.string().describe('Payment source id'),
		network: z.nativeEnum(Network).describe('Wallet network'),
		assetUnit: z.string().describe('Raw on-chain asset unit that triggered the warning'),
		thresholdAmount: z.string().describe('Configured low-balance threshold in raw on-chain units'),
		currentAmount: z.string().describe('Observed balance in raw on-chain units'),
		checkedAt: z.string().datetime().describe('Timestamp when the balance was evaluated'),
	}),
	'Wallet low-balance alert payload when a monitored wallet transitions into low balance',
);

const fundDistributionSentPayloadSchema = createWebhookPayloadSchema(
	z.literal('FUND_DISTRIBUTION_SENT'),
	z.object({
		batchId: z.string().describe('Unique identifier grouping all outputs of this distribution transaction'),
		fundWalletId: z.string().describe('Id of the fund wallet that sent the distribution'),
		fundWalletAddress: z.string().describe('Address of the fund wallet'),
		txHash: z.string().describe('On-chain transaction hash'),
		network: z.nativeEnum(Network).describe('Network the transaction was submitted on'),
		distributions: z
			.array(
				z.object({
					requestId: z.string().describe('Id of the FundDistributionRequest'),
					targetWalletId: z.string().describe('Id of the target hot wallet that received funds'),
					targetWalletAddress: z.string().describe('Address of the target wallet'),
					amount: z.string().describe('Amount sent in lovelace'),
				}),
			)
			.describe('Individual distributions included in this batch transaction'),
	}),
	'Fund distribution sent payload when a fund wallet sends ADA to one or more low-balance wallets',
);

// Union schema for all webhook payloads
export const webhookPayloadSchema = z.discriminatedUnion('event_type', [
	purchaseOnChainStatusChangedPayloadSchema,
	paymentOnChainStatusChangedPayloadSchema,
	purchaseOnErrorPayloadSchema,
	paymentOnErrorPayloadSchema,
	walletLowBalancePayloadSchema,
	fundDistributionSentPayloadSchema,
]);

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;
export type WebhookPayloadByEvent<T extends WebhookEventType> = Extract<WebhookPayload, { event_type: T }>;
export type WebhookPayloadDataByEvent<T extends WebhookEventType> = WebhookPayloadByEvent<T>['data'];

type LegacyCompatibleStoredWebhookPayload<T> = T extends { service_name: infer TServiceName }
	? Omit<T, 'service_name'> & { service_name?: TServiceName }
	: T;

export type StoredWebhookPayload = LegacyCompatibleStoredWebhookPayload<Jsonified<WebhookPayload>>;
export type StoredWebhookPayloadByEvent<T extends WebhookEventType> = Extract<StoredWebhookPayload, { event_type: T }>;

export const webhookTestPayloadSchema = z.object({
	event_type: z.literal(WEBHOOK_TEST_EVENT_TYPE),
	service_name: z.string(),
	timestamp: z.string().datetime(),
	webhook_id: z.string(),
	data: z.object({
		message: z.string(),
		webhookName: z.string().nullable(),
		webhookFormat: z.string(),
		paymentSourceId: z.string().nullable(),
		triggeredByApiKeyId: z.string(),
	}),
});

export type WebhookTestPayload = z.infer<typeof webhookTestPayloadSchema>;
export type WebhookSendPayload = StoredWebhookPayload | WebhookTestPayload;
