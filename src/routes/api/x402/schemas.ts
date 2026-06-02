import { z } from '@masumi/payment-core/zod';
import { X402PaymentDirection, X402PaymentStatus } from '@/generated/prisma/client';

export const caip2Eip155Schema = z
	.string()
	.regex(/^eip155:\d+$/, 'Network must be a CAIP-2 EVM chain id, for example eip155:8453');

export const evmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Expected an EVM address');
export const uintStringSchema = z.string().regex(/^\d+$/, 'Expected an unsigned integer string');
export const paymentIdentifierSchema = z
	.string()
	.min(16)
	.max(128)
	.regex(/^[a-zA-Z0-9_-]+$/)
	.optional();

export const x402PaymentRequirementsSchema = z.object({
	scheme: z.string(),
	network: caip2Eip155Schema,
	asset: evmAddressSchema,
	amount: uintStringSchema,
	payTo: evmAddressSchema,
	maxTimeoutSeconds: z.number().int().positive(),
	extra: z.record(z.string(), z.unknown()).optional(),
});

export const x402PaymentPayloadSchema = z.object({
	x402Version: z.number().int(),
	resource: z
		.object({
			url: z.string(),
		})
		.partial()
		.optional(),
	accepted: x402PaymentRequirementsSchema,
	payload: z.record(z.string(), z.unknown()),
	extensions: z.record(z.string(), z.unknown()).optional(),
});

export const verifySettleSchemaInput = z.object({
	supportedPaymentSourceId: z.string(),
	paymentPayload: x402PaymentPayloadSchema,
});

export const verifySchemaOutput = z.object({
	attemptId: z.string(),
	paymentPayloadHash: z.string(),
	paymentIdentifier: z.string().nullable(),
	verifyResponse: z.object({
		isValid: z.boolean(),
		invalidReason: z.string().optional(),
		invalidMessage: z.string().optional(),
		payer: z.string().optional(),
		extensions: z.record(z.string(), z.unknown()).optional(),
		extra: z.record(z.string(), z.unknown()).optional(),
	}),
});

export const settleSchemaOutput = z.object({
	attemptId: z.string(),
	paymentPayloadHash: z.string(),
	paymentIdentifier: z.string().nullable(),
	replay: z.boolean(),
	settleResponse: z.object({
		success: z.boolean(),
		errorReason: z.string().optional(),
		errorMessage: z.string().optional(),
		payer: z.string().optional(),
		transaction: z.string(),
		network: caip2Eip155Schema,
		amount: z.string().optional(),
		extensions: z.record(z.string(), z.unknown()).optional(),
		extra: z.record(z.string(), z.unknown()).optional(),
	}),
});

// The buyer forwards the raw 402 it received. `accepts` entries may target any
// chain/scheme (the service filters to the EVM exact options it can sign), so the
// fields stay loose strings here rather than the strict EVM payload schema above.
export const forwardedX402RequirementSchema = z.object({
	scheme: z.string(),
	network: z.string(),
	asset: z.string(),
	amount: uintStringSchema,
	payTo: z.string(),
	maxTimeoutSeconds: z.number().int().positive(),
	extra: z.record(z.string(), z.unknown()).optional(),
});

export const forwardedX402PaymentRequiredSchema = z.object({
	x402Version: z.number().int(),
	resource: z
		.object({
			url: z.string(),
		})
		.partial()
		.optional(),
	accepts: z
		.array(forwardedX402RequirementSchema)
		.min(1)
		.describe('The payment options advertised by the 402 response'),
	extensions: z.record(z.string(), z.unknown()).optional(),
	error: z.string().optional(),
});

export const createPaymentSchemaInput = z.object({
	evmWalletId: z.string().describe('Managed EVM wallet to sign the payment with'),
	paymentRequired: forwardedX402PaymentRequiredSchema.describe('The 402 Payment Required response the buyer received'),
	preferredNetwork: caip2Eip155Schema.optional().describe('Restrict signing to this CAIP-2 network'),
	preferredAsset: evmAddressSchema.optional().describe('Restrict signing to this token asset'),
	paymentIdentifier: paymentIdentifierSchema,
});

export const createPaymentSchemaOutput = z.object({
	attemptId: z.string(),
	payer: evmAddressSchema.describe('The managed wallet address that signed the payment'),
	caip2Network: caip2Eip155Schema,
	asset: evmAddressSchema,
	amount: uintStringSchema.describe('Signed payment amount in token base units'),
	payTo: evmAddressSchema,
	xPaymentHeader: z
		.string()
		.describe('Base64 X-PAYMENT header value; the buyer sends this with its own retried request'),
	paymentPayload: z.record(z.string(), z.unknown()).describe('The signed x402 payment payload'),
	paymentPayloadHash: z.string(),
	paymentIdentifier: z.string().nullable(),
});

export const deleteWalletSchemaInput = z.object({
	id: z.string().describe('Id of the managed EVM wallet to retire'),
});

export const deleteWalletSchemaOutput = z.object({
	id: z.string(),
});

export const walletSchemaOutput = z
	.object({
		id: z.string().describe('Unique identifier of the managed EVM wallet'),
		address: evmAddressSchema.describe('The EVM address derived from the wallet private key'),
		createdById: z.string().nullable().describe('Id of the API key that created this wallet'),
		createdAt: z.date(),
		updatedAt: z.date(),
	})
	.openapi('X402Wallet');

export const createWalletSchemaInput = z.object({
	privateKey: z
		.string()
		.regex(/^0x[a-fA-F0-9]{64}$/, 'privateKey must be a 32-byte hex private key')
		.optional()
		.describe('Optional 0x-prefixed 32-byte hex private key. A new key is generated when omitted.'),
});

export const listWalletsSchemaOutput = z.object({
	Wallets: z.array(walletSchemaOutput),
});

export const createWalletSchemaOutput = walletSchemaOutput;

export const x402NetworkSchema = z
	.object({
		id: z.string(),
		caip2Id: caip2Eip155Schema.describe('CAIP-2 EVM chain id, for example eip155:8453'),
		displayName: z.string().describe('Human readable chain name'),
		rpcUrl: z.string().describe('HTTP(S) RPC endpoint used to talk to the chain'),
		isTestnet: z.boolean().describe('Whether this chain is a testnet (paired with the Cardano Preprod environment)'),
		isEnabled: z.boolean().describe('Whether this chain may be used for x402 payments'),
		defaultAsset: evmAddressSchema.nullable().describe('Default settlement asset (token contract) for this chain'),
		facilitatorWalletId: z
			.string()
			.nullable()
			.describe('Id of the managed EVM wallet used to settle payments on this chain'),
		createdById: z.string().nullable().describe('Id of the API key that created this chain configuration'),
		createdAt: z.date(),
		updatedAt: z.date(),
	})
	.openapi('X402Network');

export const upsertNetworkSchemaInput = z.object({
	caip2Id: caip2Eip155Schema,
	displayName: z.string().min(1).max(120),
	rpcUrl: z.string().url(),
	isTestnet: z.boolean().optional(),
	isEnabled: z.boolean().optional(),
	defaultAsset: evmAddressSchema.nullable().optional(),
	facilitatorWalletId: z.string().nullable().optional(),
});

export const listNetworksSchemaOutput = z.object({
	Networks: z.array(x402NetworkSchema),
});

export const budgetSchema = z
	.object({
		id: z.string(),
		apiKeyId: z.string().describe('API key the budget is granted to'),
		evmWalletId: z.string().describe('Managed EVM wallet the budget draws from'),
		caip2Network: caip2Eip155Schema,
		asset: evmAddressSchema.describe('Token contract the budget is denominated in'),
		remainingAmount: z.string().describe('Remaining spendable amount, in token base units'),
		spentAmount: z.string().describe('Amount already spent, in token base units'),
		createdById: z.string().nullable().describe('Id of the API key that created this budget'),
		createdAt: z.date(),
		updatedAt: z.date(),
	})
	.openapi('X402Budget');

export const setBudgetSchemaInput = z.object({
	apiKeyId: z.string(),
	evmWalletId: z.string(),
	caip2Network: caip2Eip155Schema,
	asset: evmAddressSchema,
	remainingAmount: uintStringSchema,
});

export const listBudgetSchemaInput = z.object({
	apiKeyId: z.string().optional().describe('Filter budgets to a single API key'),
});

export const listBudgetSchemaOutput = z.object({
	Budgets: z.array(budgetSchema),
});

export const x402SettlementSummarySchema = z.object({
	id: z.string(),
	success: z.boolean(),
	txHash: z.string().nullable().describe('On-chain settlement transaction hash'),
	amount: z.string().nullable().describe('Settled amount in token base units'),
	payer: z.string().nullable(),
	createdAt: z.date(),
});

export const x402PaymentAttemptSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		direction: z.nativeEnum(X402PaymentDirection),
		status: z.nativeEnum(X402PaymentStatus),
		apiKeyId: z.string(),
		evmWalletId: z.string().nullable(),
		registryRequestId: z.string().nullable(),
		supportedPaymentSourceId: z.string().nullable(),
		caip2Network: z.string(),
		asset: z.string(),
		amount: z.string().describe('Payment amount in token base units'),
		payTo: z.string(),
		payer: z.string().nullable(),
		resource: z.string().nullable(),
		paymentIdentifier: z.string().nullable(),
		errorReason: z.string().nullable(),
		errorMessage: z.string().nullable(),
		Settlement: x402SettlementSummarySchema.nullable(),
	})
	.openapi('X402PaymentAttempt');

export const listPaymentAttemptsSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(20).describe('Number of payment attempts to return'),
	cursorId: z.string().max(550).optional().describe('Pagination cursor (provide the id of the last returned attempt)'),
	status: z.nativeEnum(X402PaymentStatus).optional().describe('Filter by payment status'),
	direction: z.nativeEnum(X402PaymentDirection).optional().describe('Filter by payment direction'),
	caip2Network: caip2Eip155Schema.optional().describe('Filter by CAIP-2 chain id'),
});

export const listPaymentAttemptsSchemaOutput = z.object({
	PaymentAttempts: z.array(x402PaymentAttemptSchema),
});

export const x402SettlementSchema = z
	.object({
		id: z.string(),
		createdAt: z.date(),
		updatedAt: z.date(),
		paymentAttemptId: z.string(),
		success: z.boolean(),
		txHash: z.string().nullable(),
		caip2Network: z.string(),
		amount: z.string().nullable(),
		payer: z.string().nullable(),
	})
	.openapi('X402SettlementRecord');

export const listSettlementsSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(20).describe('Number of settlements to return'),
	cursorId: z
		.string()
		.max(550)
		.optional()
		.describe('Pagination cursor (provide the id of the last returned settlement)'),
	caip2Network: caip2Eip155Schema.optional().describe('Filter by CAIP-2 chain id'),
});

export const listSettlementsSchemaOutput = z.object({
	Settlements: z.array(x402SettlementSchema),
});
