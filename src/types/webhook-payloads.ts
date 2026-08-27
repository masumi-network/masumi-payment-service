import {
	HotWalletType,
	Network,
	PaymentSourceType,
	WebhookEventType,
	X402EvmWalletType,
} from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
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
		paymentSourceType: z.nativeEnum(PaymentSourceType).describe('Payment source type'),
		network: z.nativeEnum(Network).describe('Wallet network'),
		assetUnit: z.string().describe('Raw on-chain asset unit that triggered the warning'),
		thresholdAmount: z.string().describe('Configured low-balance threshold in raw on-chain units'),
		currentAmount: z.string().describe('Observed balance in raw on-chain units'),
		checkedAt: z.string().datetime().describe('Timestamp when the balance was evaluated'),
	}),
	'Wallet low-balance alert payload when a monitored wallet transitions into low balance',
);

// Fund distribution reports all three outcomes of a batch. SENT alone is not
// enough for an unattended feature: a batch can be submitted and then fail to
// confirm (or be rolled back after its TTL provably elapses), and an operator
// told only "sent" would never learn the top-up did not land.
const fundDistributionBatchShape = {
	batchId: z.string().describe('Unique identifier grouping all outputs of this distribution transaction'),
	fundWalletId: z.string().describe('Id of the fund wallet that sent the distribution'),
	fundWalletAddress: z.string().describe('Address of the fund wallet'),
	network: z.nativeEnum(Network).describe('Network the transaction was submitted on'),
	distributions: z
		.array(
			z.object({
				requestId: z.string().describe('Id of the FundDistributionRequest'),
				targetWalletId: z.string().describe('Id of the target hot wallet that received funds'),
				targetWalletAddress: z.string().describe('Address of the target wallet'),
				assetUnit: z.string().describe('"lovelace" for ADA, otherwise policy id plus hex asset name'),
				amount: z.string().describe("Amount sent in the asset's smallest on-chain unit"),
			}),
		)
		.describe('Individual distributions included in this batch transaction'),
};

const fundDistributionSentPayloadSchema = createWebhookPayloadSchema(
	z.literal('FUND_DISTRIBUTION_SENT'),
	z.object({
		...fundDistributionBatchShape,
		txHash: z.string().describe('On-chain transaction hash'),
	}),
	'Fund distribution sent payload when a fund wallet submits assets to one or more low-balance wallets. Submission only — see FUND_DISTRIBUTION_CONFIRMED / FUND_DISTRIBUTION_FAILED for the outcome',
);

const fundDistributionConfirmedPayloadSchema = createWebhookPayloadSchema(
	z.literal('FUND_DISTRIBUTION_CONFIRMED'),
	z.object({
		...fundDistributionBatchShape,
		txHash: z.string().describe('On-chain transaction hash'),
	}),
	'Fund distribution confirmed payload when a previously sent distribution transaction is observed on chain',
);

const fundDistributionFailedPayloadSchema = createWebhookPayloadSchema(
	z.literal('FUND_DISTRIBUTION_FAILED'),
	z.object({
		...fundDistributionBatchShape,
		txHash: z
			.string()
			.nullable()
			.describe('On-chain transaction hash if the batch was broadcast, null if it failed before submission'),
		error: z.string().describe('Why the distribution failed'),
	}),
	'Fund distribution failed payload when a distribution could not be submitted, or was submitted but never confirmed on chain',
);

// x402 (EVM) webhook schemas. The settle event carries the same data on success and
// failure so a single consumer shape covers both X402_PAYMENT_SETTLED and
// X402_PAYMENT_FAILED.
const x402PaymentEventData = z.object({
	attemptId: z.string().describe('x402 payment attempt id'),
	paymentPayloadHash: z.string().nullable().describe('Canonical hash of the settled payment payload'),
	supportedPaymentSourceId: z.string().nullable().describe('Registered EVM payment source id'),
	registryRequestId: z.string().nullable().describe('Registry request the payment was for'),
	caip2Network: z.string().describe('CAIP-2 chain id'),
	asset: z.string().describe('Token contract'),
	amount: z.string().describe('Amount in token base units'),
	payTo: z.string().describe('Recipient address'),
	payer: z.string().nullable().describe('Payer address'),
	txHash: z.string().nullable().describe('On-chain settlement transaction hash, when settled'),
	success: z.boolean().describe('Whether the settlement succeeded'),
	errorReason: z.string().nullable().describe('Machine-readable failure reason, when failed'),
	errorMessage: z.string().nullable().describe('Human-readable failure message, when failed'),
	settledAt: z.string().datetime().describe('Timestamp the settlement was recorded'),
});

const x402PaymentSettledPayloadSchema = createWebhookPayloadSchema(
	z.literal('X402_PAYMENT_SETTLED'),
	x402PaymentEventData,
	'Emitted when an inbound x402 payment is settled on-chain',
);

const x402PaymentFailedPayloadSchema = createWebhookPayloadSchema(
	z.literal('X402_PAYMENT_FAILED'),
	x402PaymentEventData,
	'Emitted when an inbound x402 settlement fails',
);

const x402WalletLowBalancePayloadSchema = createWebhookPayloadSchema(
	z.literal('X402_WALLET_LOW_BALANCE'),
	z.object({
		ruleId: z.string().describe('Low-balance rule id'),
		evmWalletId: z.string().describe('Managed EVM wallet id'),
		walletAddress: z.string().describe('Managed EVM wallet address'),
		walletType: z.nativeEnum(X402EvmWalletType).describe('Wallet direction (Purchasing or Selling)'),
		caip2Network: z.string().describe('CAIP-2 chain id of the monitored balance'),
		asset: z.string().describe('Monitored asset: "native" or an ERC-20 contract'),
		thresholdAmount: z.string().describe('Configured threshold in base units'),
		currentAmount: z.string().describe('Observed balance in base units'),
		checkedAt: z.string().datetime().describe('Timestamp when the balance was evaluated'),
	}),
	'Emitted when a monitored managed EVM wallet transitions into low balance',
);

const hydraHeadLowBalancePayloadSchema = createWebhookPayloadSchema(
	z.literal('HYDRA_HEAD_LOW_BALANCE'),
	z.object({
		ruleId: z.string().describe('Low-balance rule id'),
		hydraLocalParticipantId: z.string().describe('Local participant whose in-head balance is monitored'),
		hydraHeadId: z.string().describe('The open head the balance was read from'),
		assetUnit: z.string().describe('Monitored asset: "lovelace" or policyId+assetName hex'),
		thresholdAmount: z.string().describe('Configured threshold in the asset base unit'),
		currentAmount: z.string().describe('Observed own in-head balance in the asset base unit'),
		checkedAt: z.string().datetime().describe('Timestamp when the in-head balance was evaluated'),
	}),
	'Emitted when a local participant’s own in-head balance transitions into low balance',
);

// Union schema for all webhook payloads
const _webhookPayloadSchema = z.discriminatedUnion('event_type', [
	purchaseOnChainStatusChangedPayloadSchema,
	paymentOnChainStatusChangedPayloadSchema,
	purchaseOnErrorPayloadSchema,
	paymentOnErrorPayloadSchema,
	walletLowBalancePayloadSchema,
	fundDistributionSentPayloadSchema,
	fundDistributionConfirmedPayloadSchema,
	fundDistributionFailedPayloadSchema,
	x402PaymentSettledPayloadSchema,
	x402PaymentFailedPayloadSchema,
	x402WalletLowBalancePayloadSchema,
	hydraHeadLowBalancePayloadSchema,
]);

type WebhookPayload = z.infer<typeof _webhookPayloadSchema>;
export type WebhookPayloadByEvent<T extends WebhookEventType> = Extract<WebhookPayload, { event_type: T }>;
export type WebhookPayloadDataByEvent<T extends WebhookEventType> = WebhookPayloadByEvent<T>['data'];

type LegacyCompatibleStoredWebhookPayload<T> = T extends { service_name: infer TServiceName }
	? Omit<T, 'service_name'> & { service_name?: TServiceName }
	: T;

export type StoredWebhookPayload = LegacyCompatibleStoredWebhookPayload<Jsonified<WebhookPayload>>;

const _webhookTestPayloadSchema = z.object({
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

export type WebhookTestPayload = z.infer<typeof _webhookTestPayloadSchema>;
export type WebhookSendPayload = StoredWebhookPayload | WebhookTestPayload;
