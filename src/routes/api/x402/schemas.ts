import { z } from '@masumi/payment-core/zod';
import { MAX_X402_TIMEOUT_SECONDS } from '@masumi/payment-source-x402';
import {
	LowBalanceStatus,
	X402EvmWalletType,
	X402PaymentDirection,
	X402PaymentStatus,
} from '@/generated/prisma/client';

export const caip2Eip155Schema = z
	.string()
	.regex(/^eip155:\d+$/, 'Network must be a CAIP-2 EVM chain id, for example eip155:8453');

export const evmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Expected an EVM address');
// Sentinel addresses some ecosystems use for the native asset are
// syntactically valid but can never be an ERC-20 contract.
const EVM_NATIVE_SENTINEL_ADDRESSES = new Set([
	'0x0000000000000000000000000000000000000000',
	'0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
]);
export const x402AssetSchema = evmAddressSchema
	.refine(
		(asset) => !EVM_NATIVE_SENTINEL_ADDRESSES.has(asset.toLowerCase()),
		'x402 asset must be an ERC-20 token contract, not a native-asset sentinel address',
	)
	.describe('ERC-20 token contract address');
export const uintStringSchema = z.string().regex(/^\d+$/, 'Expected an unsigned integer string');
// A boolean carried in a query string. z.coerce.boolean() is WRONG here: Boolean("false")
// is true, so "false" would read as true. Parse the literal string instead.
export const booleanQuerySchema = z.enum(['true', 'false']).transform((value) => value === 'true');
export const paymentIdentifierSchema = z
	.string()
	.min(16)
	.max(128)
	.regex(/^[a-zA-Z0-9_-]+$/)
	.optional();

export const x402PaymentRequirementsSchema = z.object({
	scheme: z.string(),
	network: caip2Eip155Schema,
	asset: x402AssetSchema,
	amount: uintStringSchema,
	payTo: evmAddressSchema,
	// Upper bound mirrors the service-side policy cap for Dynamic runtime
	// requirements; Fixed sources pin 300s regardless.
	maxTimeoutSeconds: z.number().int().positive().max(MAX_X402_TIMEOUT_SECONDS),
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
	paymentRequirements: x402PaymentRequirementsSchema
		.optional()
		.describe(
			'Trusted requirements originally issued by the authenticated resource server. Required for Dynamic registry pricing; Fixed pricing is derived from the registry.',
		),
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
		.max(20)
		.describe('The payment options advertised by the 402 response'),
	extensions: z.record(z.string(), z.unknown()).optional(),
	error: z.string().optional(),
});

export const createPaymentSchemaInput = z.object({
	evmWalletId: z.string().describe('Managed EVM wallet to sign the payment with'),
	paymentRequired: forwardedX402PaymentRequiredSchema.describe('The 402 Payment Required response the buyer received'),
	preferredNetwork: caip2Eip155Schema.optional().describe('Restrict signing to this CAIP-2 network'),
	preferredAsset: x402AssetSchema.optional().describe('Restrict signing to this token asset'),
	paymentIdentifier: paymentIdentifierSchema,
});

export const createPaymentSchemaOutput = z.object({
	attemptId: z.string(),
	payer: evmAddressSchema.describe('The managed wallet address that signed the payment'),
	caip2Network: caip2Eip155Schema,
	asset: x402AssetSchema,
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

export const walletNoteSchema = z.string().max(250).describe('Optional human-readable label for the wallet');

export const walletSchemaOutput = z
	.object({
		id: z.string().describe('Unique identifier of the managed EVM wallet'),
		networkId: z.string().describe('Id of the x402 network (payment source) this wallet is bound to'),
		caip2Network: caip2Eip155Schema.describe('CAIP-2 chain id of the network this wallet is bound to'),
		address: evmAddressSchema.describe('The EVM address derived from the wallet private key'),
		type: z
			.nativeEnum(X402EvmWalletType)
			.describe('Purchasing wallets fund outbound payments; Selling wallets settle inbound ones as facilitators'),
		note: z.string().nullable().describe('Optional human-readable label for the wallet'),
		createdById: z.string().nullable().describe('Id of the API key that created this wallet'),
		createdAt: z.date(),
		updatedAt: z.date(),
	})
	.openapi('X402Wallet');

export const createWalletSchemaInput = z.object({
	networkId: z.string().describe('Id of the x402 network (payment source) to bind this wallet to'),
	type: z
		.nativeEnum(X402EvmWalletType)
		.describe('Purchasing wallets fund outbound payments; Selling wallets settle inbound ones as facilitators'),
	note: walletNoteSchema.optional(),
	privateKey: z
		.string()
		.regex(/^0x[a-fA-F0-9]{64}$/, 'privateKey must be a 32-byte hex private key')
		.optional()
		.describe('Optional 0x-prefixed 32-byte hex private key. A new key is generated when omitted.'),
});

export const updateWalletSchemaInput = z.object({
	id: z.string().describe('Id of the managed EVM wallet to update'),
	note: walletNoteSchema.nullable().describe('New label for the wallet; null clears it'),
});

export const listWalletsSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(20).describe('Number of managed wallets to return'),
	cursorId: z.string().max(550).optional().describe('Pagination cursor (provide the id of the last returned wallet)'),
	type: z.nativeEnum(X402EvmWalletType).optional().describe('Filter wallets by direction (Purchasing or Selling)'),
	networkId: z.string().optional().describe('Filter wallets by the bound x402 network id'),
});

export const walletDetailSchemaInput = z.object({
	id: z.string().describe('Id of the managed EVM wallet to fetch'),
});

export const countSchemaOutput = z.object({ total: z.number().describe('Total number of matching records') });

export const paymentAttemptsCountSchemaInput = z.object({
	status: z.nativeEnum(X402PaymentStatus).optional(),
	direction: z.nativeEnum(X402PaymentDirection).optional(),
	side: z.enum(['buy', 'sell']).optional().describe('Coarse side filter: buy = outbound, sell = inbound'),
	caip2Network: caip2Eip155Schema.optional(),
	filterNeedsManualAction: booleanQuerySchema
		.optional()
		.describe(
			'When true, only counts attempts that require manual reconciliation: a settle that failed, threw, or was interrupted without recording its outcome (a stale Verified marker, or a stale Settled attempt missing its settlement record). Overrides the status filter.',
		),
});

export const settlementsCountSchemaInput = z.object({
	caip2Network: caip2Eip155Schema.optional(),
	success: booleanQuerySchema.optional(),
});

export const walletsCountSchemaInput = z.object({
	type: z.nativeEnum(X402EvmWalletType).optional(),
});

export const walletBalanceSchemaInput = z.object({
	id: z.string().describe('Id of the managed EVM wallet to read balances for'),
	caip2Network: caip2Eip155Schema
		.optional()
		.describe("Optional CAIP-2 chain id; must be the wallet's bound network (any other chain returns no balances)"),
});

export const walletBalanceSchemaOutput = z.object({
	evmWalletId: z.string(),
	address: evmAddressSchema,
	Balances: z.array(
		z.object({
			caip2Network: caip2Eip155Schema,
			displayName: z.string(),
			native: z
				.object({
					symbol: z.string(),
					decimals: z.number(),
					amount: z.string().describe('Native gas balance in wei'),
				})
				.nullable(),
			asset: z
				.object({
					asset: evmAddressSchema,
					symbol: z.string().nullable(),
					decimals: z.number(),
					amount: z.string().describe('Token balance in base units'),
				})
				.nullable(),
			error: z.string().nullable().describe('Set when this chain could not be read'),
		}),
	),
});

// "native" denotes the chain's gas token; otherwise an ERC-20 contract address.
export const lowBalanceAssetSchema = z
	.union([z.literal('native'), evmAddressSchema])
	.describe('Asset to monitor: "native" for the gas token, or an ERC-20 contract address');

export const lowBalanceRuleSchema = z
	.object({
		id: z.string(),
		evmWalletId: z.string(),
		evmWalletAddress: z.string(),
		caip2Network: caip2Eip155Schema,
		asset: z.string(),
		thresholdAmount: z.string().describe('Alert threshold in base units'),
		enabled: z.boolean(),
		status: z.nativeEnum(LowBalanceStatus),
		lastKnownAmount: z.string().nullable(),
		lastCheckedAt: z.date().nullable(),
		lastAlertedAt: z.date().nullable(),
		createdAt: z.date(),
		updatedAt: z.date(),
	})
	.openapi('X402LowBalanceRule');

export const setLowBalanceRuleSchemaInput = z.object({
	evmWalletId: z.string(),
	caip2Network: caip2Eip155Schema,
	asset: lowBalanceAssetSchema,
	thresholdAmount: uintStringSchema.describe('Alert threshold in base units'),
	enabled: z.boolean().optional(),
});

export const listLowBalanceRulesSchemaInput = z.object({
	evmWalletId: z.string().optional().describe('Filter rules to a single wallet'),
	onlyLow: booleanQuerySchema.optional().describe('Only return rules currently in the Low state'),
	includeDisabled: booleanQuerySchema.optional().describe('Include disabled rules'),
});

export const updateLowBalanceRuleSchemaInput = z.object({
	ruleId: z.string(),
	thresholdAmount: uintStringSchema.optional(),
	enabled: z.boolean().optional(),
});

export const deleteLowBalanceRuleSchemaInput = z.object({ ruleId: z.string() });
export const deleteLowBalanceRuleSchemaOutput = z.object({ ruleId: z.string(), deletedAt: z.date() });

export const listLowBalanceRulesSchemaOutput = z.object({ Rules: z.array(lowBalanceRuleSchema) });

const analyticsUnitSchema = z.object({
	caip2Network: caip2Eip155Schema,
	asset: z.string(),
	amount: z.string().describe('Summed amount in base units'),
});

export const analyticsSchemaInput = z.object({
	startDate: z.coerce.date().optional().describe('Window start (defaults to 30 days ago)'),
	endDate: z.coerce.date().optional().describe('Window end (defaults to now)'),
	caip2Network: caip2Eip155Schema.optional().describe('Restrict to a single chain'),
	timeZone: z.string().optional().describe('IANA timezone for day/month bucketing (default Etc/UTC)'),
});

export const analyticsSchemaOutput = z.object({
	periodStart: z.date(),
	periodEnd: z.date(),
	incomeCount: z.number().describe('Number of settled inbound payments'),
	spendCount: z.number().describe('Number of signed outbound payments'),
	TotalIncome: z.array(analyticsUnitSchema),
	TotalSpend: z.array(analyticsUnitSchema),
	Daily: z.array(
		z.object({
			year: z.number(),
			month: z.number(),
			day: z.number(),
			Income: z.array(analyticsUnitSchema),
			Spend: z.array(analyticsUnitSchema),
		}),
	),
	Monthly: z.array(
		z.object({
			year: z.number(),
			month: z.number(),
			Income: z.array(analyticsUnitSchema),
			Spend: z.array(analyticsUnitSchema),
		}),
	),
});

export const listWalletsSchemaOutput = z.object({
	Wallets: z.array(walletSchemaOutput),
});

export const createWalletSchemaOutput = walletSchemaOutput
	.extend({
		privateKey: z
			.string()
			.nullable()
			.describe(
				'The generated 0x-prefixed private key, returned ONCE so you can back it up. It is null when you supplied your own key, is never stored in plaintext, and can never be retrieved again. Save it now.',
			),
	})
	.openapi('X402WalletCreated');

export const x402NetworkSchema = z
	.object({
		id: z.string(),
		caip2Id: caip2Eip155Schema.describe('CAIP-2 EVM chain id, for example eip155:8453'),
		displayName: z.string().describe('Human readable chain name'),
		rpcUrl: z.string().describe('HTTP(S) RPC endpoint used to talk to the chain'),
		isTestnet: z.boolean().describe('Whether this chain is a testnet (paired with the Cardano Preprod environment)'),
		isEnabled: z.boolean().describe('Whether this chain may be used for x402 payments'),
		defaultAsset: evmAddressSchema.nullable().describe('Default settlement asset (token contract) for this chain'),
		defaultAssetDecimals: z
			.number()
			.int()
			.min(0)
			.max(255)
			.nullable()
			.describe('Decimals for the default settlement asset; null until an operator confirms them'),
		facilitatorWalletId: z
			.string()
			.nullable()
			.describe('Id of the managed EVM wallet used to settle payments on this chain (self-hosted facilitator)'),
		facilitatorWalletAddress: z
			.string()
			.nullable()
			.describe('Resolved address of the facilitator wallet. Null when no self-hosted facilitator is set.'),
		facilitatorUrl: z
			.string()
			.nullable()
			.describe(
				'HTTPS URL of a remote x402 facilitator used to settle payments on this chain (no owned wallet needed)',
			),
		createdById: z.string().nullable().describe('Id of the API key that created this chain configuration'),
		createdAt: z.date(),
		updatedAt: z.date(),
	})
	.openapi('X402Network');

export const x402AvailableNetworkSchema = z
	.object({
		id: z.string().describe('Opaque x402 network id accepted by managed-wallet endpoints'),
		caip2Id: caip2Eip155Schema.describe('CAIP-2 EVM chain id, for example eip155:8453'),
		displayName: z.string().describe('Human readable chain name'),
		isTestnet: z.boolean().describe('Whether this chain belongs to the testnet environment'),
		isEnabled: z.boolean().describe('Whether this chain may currently be used for x402 payments'),
		canSettle: z
			.boolean()
			.describe(
				'Whether inbound settlement is configured (a facilitator wallet or URL is present). Outbound (buy) wallets do not require a facilitator, so networks may be listed with canSettle=false.',
			),
		defaultAsset: evmAddressSchema.nullable().describe('Default settlement asset (token contract) for this chain'),
		defaultAssetDecimals: z
			.number()
			.int()
			.min(0)
			.max(255)
			.nullable()
			.describe('Decimals for the default settlement asset; null until an operator confirms them'),
	})
	.openapi('X402AvailableNetwork');

export const upsertNetworkSchemaInput = z.object({
	caip2Id: caip2Eip155Schema,
	displayName: z.string().min(1).max(120),
	rpcUrl: z
		.string()
		.url()
		.regex(/^https?:\/\//, 'RPC URL must use HTTP or HTTPS'),
	isTestnet: z.boolean().optional(),
	isEnabled: z.boolean().optional(),
	defaultAsset: evmAddressSchema.nullable().optional(),
	defaultAssetDecimals: z.number().int().min(0).max(255).nullable().optional(),
	// Configure the facilitator in exactly one mode: an owned Selling wallet (self-hosted) or a
	// remote facilitator URL. Supplying both is rejected by the service. Every field is tri-state
	// on update: omit to keep the stored value, send a string to set it, or send explicit null to
	// clear it. Sending both selectors as null detaches the facilitator entirely.
	facilitatorWalletId: z
		.string()
		.nullable()
		.optional()
		.describe('Self-hosted facilitator: owned Selling wallet id (null clears it)'),
	facilitatorUrl: z
		.string()
		.url()
		.regex(/^https:\/\//, 'Remote facilitator URL must use HTTPS')
		.nullable()
		.optional()
		.describe('Remote facilitator: HTTPS endpoint (null clears it)'),
	facilitatorAuth: z
		.string()
		.nullable()
		.optional()
		.describe(
			'Authorization header value for the remote facilitator, stored encrypted at rest. Omit to preserve it only when the URL origin is unchanged; changing origin clears it. Send a string to set/rotate it, or null to clear it. Requires a remote facilitator URL (existing or set in the same request).',
		),
});

export const listNetworksSchemaInput = z.object({
	isTestnet: booleanQuerySchema
		.optional()
		.describe('Filter chains by environment: true for testnet (Preprod), false for mainnet'),
});

export const listNetworksSchemaOutput = z.object({
	Networks: z.array(x402NetworkSchema),
});

export const listAvailableNetworksSchemaOutput = z.object({
	Networks: z.array(x402AvailableNetworkSchema),
});

export const budgetSchema = z
	.object({
		id: z.string(),
		apiKeyId: z.string().describe('API key the budget is granted to'),
		evmWalletId: z.string().describe('Managed EVM wallet the budget draws from'),
		evmWalletAddress: z.string().describe('Resolved address of the managed EVM wallet the budget draws from'),
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
		payTo: z
			.string()
			.nullable()
			.describe('Immutable payee-address snapshot. Null only for legacy transition rows without a snapshot.'),
		payer: z.string().nullable(),
		resource: z.string().nullable(),
		paymentIdentifier: z.string().nullable(),
		errorReason: z.string().nullable(),
		errorMessage: z.string().nullable(),
		facilitator: z
			.object({
				mode: z
					.enum(['self_hosted', 'remote', 'unknown'])
					.describe('Whether an owned wallet, a remote URL, or an unknown legacy facilitator settled'),
				address: z
					.string()
					.nullable()
					.describe('Self-hosted facilitator wallet address; null for remote or unknown legacy mode'),
			})
			.nullable()
			.describe('The facilitator that settled this inbound payment; null for outbound payments and verifies.'),
		Settlement: x402SettlementSummarySchema.nullable(),
	})
	.openapi('X402PaymentAttempt');

export const listPaymentAttemptsSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(20).describe('Number of payment attempts to return'),
	cursorId: z.string().max(550).optional().describe('Pagination cursor (provide the id of the last returned attempt)'),
	status: z.nativeEnum(X402PaymentStatus).optional().describe('Filter by payment status'),
	direction: z.nativeEnum(X402PaymentDirection).optional().describe('Filter by payment direction'),
	side: z
		.enum(['buy', 'sell'])
		.optional()
		.describe('Coarse side filter: buy = outbound payments, sell = inbound (verify + settle). A direction wins.'),
	caip2Network: caip2Eip155Schema.optional().describe('Filter by CAIP-2 chain id'),
	filterNeedsManualAction: booleanQuerySchema
		.optional()
		.describe(
			'When true, only returns attempts that require manual reconciliation: a settle that failed, threw, or was interrupted without recording its outcome (a stale Verified marker, or a stale Settled attempt missing its settlement record). Overrides the status filter.',
		),
});

export const listPaymentAttemptsSchemaOutput = z.object({
	PaymentAttempts: z.array(x402PaymentAttemptSchema),
});

const reconcileAttemptIdSchema = z.string().describe('Id of the InboundSettle attempt awaiting reconciliation');
const reconcileTxHashSchema = z
	.string()
	.regex(/^0x[a-fA-F0-9]{64}$/, 'txHash must be a 0x-prefixed 32-byte hex transaction hash')
	.describe('On-chain settlement transaction hash');

export const reconcilePaymentSchemaInput = z.discriminatedUnion('resolution', [
	z
		.object({
			attemptId: reconcileAttemptIdSchema,
			resolution: z.literal('settled').describe('Funds moved on-chain'),
			txHash: reconcileTxHashSchema,
		})
		.strict(),
	z
		.object({
			attemptId: reconcileAttemptIdSchema,
			resolution: z.literal('failed').describe('Funds did not move on-chain and the payment is safe to retry'),
		})
		.strict(),
]);

export const reconcilePaymentSchemaOutput = z.object({
	attemptId: z.string(),
	status: z.nativeEnum(X402PaymentStatus),
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
