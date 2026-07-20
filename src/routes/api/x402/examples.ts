import { X402EvmWalletType, X402PaymentDirection, X402PaymentStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import {
	budgetSchema,
	createPaymentSchemaOutput,
	createWalletSchemaInput,
	createWalletSchemaOutput,
	listAvailableNetworksSchemaOutput,
	listBudgetSchemaOutput,
	listNetworksSchemaOutput,
	listPaymentAttemptsSchemaOutput,
	listSettlementsSchemaOutput,
	listWalletsSchemaOutput,
	settleSchemaOutput,
	verifySchemaOutput,
	verifySettleSchemaInput,
	walletSchemaOutput,
	x402AvailableNetworkSchema,
	x402NetworkSchema,
	x402PaymentAttemptSchema,
	x402SettlementSchema,
} from './schemas';

const exampleDate = new Date('2026-06-02T12:00:00.000Z');
const exampleUsdcAsset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const examplePayer = '0x3333333333333333333333333333333333333333';

export const x402WalletExample = {
	id: 'clmanagedwallet0001',
	networkId: 'clx402network0001',
	caip2Network: 'eip155:8453',
	address: '0x1111111111111111111111111111111111111111',
	type: X402EvmWalletType.Purchasing,
	note: 'Agent payout buyer wallet',
	createdById: 'api_key_id',
	createdAt: exampleDate,
	updatedAt: exampleDate,
} satisfies z.infer<typeof walletSchemaOutput>;

// A Selling wallet settles inbound payments, so the facilitator examples reference this
// one rather than the Purchasing wallet above.
export const x402FacilitatorWalletExample = {
	id: 'clmanagedwallet0002',
	networkId: 'clx402network0001',
	caip2Network: 'eip155:8453',
	address: '0x5555555555555555555555555555555555555555',
	type: X402EvmWalletType.Selling,
	note: 'Base facilitator',
	createdById: 'api_key_id',
	createdAt: exampleDate,
	updatedAt: exampleDate,
} satisfies z.infer<typeof walletSchemaOutput>;

export const x402NetworkExample = {
	id: 'clx402network0001',
	caip2Id: 'eip155:8453',
	displayName: 'Base',
	rpcUrl: 'https://mainnet.base.org',
	isTestnet: false,
	isEnabled: true,
	defaultAsset: exampleUsdcAsset,
	defaultAssetDecimals: 6,
	facilitatorWalletId: x402FacilitatorWalletExample.id,
	facilitatorWalletAddress: x402FacilitatorWalletExample.address,
	facilitatorUrl: null,
	createdById: 'api_key_id',
	createdAt: exampleDate,
	updatedAt: exampleDate,
} satisfies z.infer<typeof x402NetworkSchema>;

const x402AvailableNetworkExample = {
	id: x402NetworkExample.id,
	caip2Id: x402NetworkExample.caip2Id,
	displayName: x402NetworkExample.displayName,
	isTestnet: x402NetworkExample.isTestnet,
	isEnabled: x402NetworkExample.isEnabled,
	defaultAsset: x402NetworkExample.defaultAsset,
	defaultAssetDecimals: x402NetworkExample.defaultAssetDecimals,
} satisfies z.infer<typeof x402AvailableNetworkSchema>;

export const x402BudgetExample = {
	id: 'clx402budget0001',
	apiKeyId: 'api_key_id',
	evmWalletId: x402WalletExample.id,
	evmWalletAddress: x402WalletExample.address,
	caip2Network: 'eip155:8453',
	asset: exampleUsdcAsset,
	remainingAmount: '1000000',
	spentAmount: '0',
	createdById: 'api_key_id',
	createdAt: exampleDate,
	updatedAt: exampleDate,
} satisfies z.infer<typeof budgetSchema>;

export const x402PaymentAttemptExample = {
	id: 'clx402attempt0001',
	createdAt: exampleDate,
	updatedAt: exampleDate,
	direction: X402PaymentDirection.InboundSettle,
	status: X402PaymentStatus.Settled,
	apiKeyId: 'api_key_id',
	evmWalletId: x402FacilitatorWalletExample.id,
	registryRequestId: null,
	supportedPaymentSourceId: 'supported_payment_source_id',
	caip2Network: 'eip155:8453',
	asset: exampleUsdcAsset,
	amount: '1000000',
	payTo: '0x2222222222222222222222222222222222222222',
	payer: examplePayer,
	resource: null,
	paymentIdentifier: null,
	errorReason: null,
	errorMessage: null,
	facilitator: { mode: 'self_hosted', address: x402FacilitatorWalletExample.address },
	Settlement: {
		id: 'clx402settlement0001',
		success: true,
		txHash: '0x4242424242424242424242424242424242424242424242424242424242424242',
		amount: '1000000',
		payer: examplePayer,
		createdAt: exampleDate,
	},
} satisfies z.infer<typeof x402PaymentAttemptSchema>;

export const x402SettlementExample = {
	id: 'clx402settlement0001',
	createdAt: exampleDate,
	updatedAt: exampleDate,
	paymentAttemptId: x402PaymentAttemptExample.id,
	success: true,
	txHash: '0x4242424242424242424242424242424242424242424242424242424242424242',
	caip2Network: 'eip155:8453',
	amount: '1000000',
	payer: examplePayer,
} satisfies z.infer<typeof x402SettlementSchema>;

export const listX402WalletsQueryExample = {
	take: 20,
	cursorId: 'clmanagedwallet0001',
};

export const listX402WalletsResponseExample = {
	Wallets: [x402WalletExample, x402FacilitatorWalletExample],
} satisfies z.infer<typeof listWalletsSchemaOutput>;

export const listX402NetworksResponseExample = {
	Networks: [x402NetworkExample],
} satisfies z.infer<typeof listNetworksSchemaOutput>;

export const listAvailableX402NetworksResponseExample = {
	Networks: [x402AvailableNetworkExample],
} satisfies z.infer<typeof listAvailableNetworksSchemaOutput>;

export const listX402BudgetsResponseExample = {
	Budgets: [x402BudgetExample],
} satisfies z.infer<typeof listBudgetSchemaOutput>;

export const listX402PaymentAttemptsResponseExample = {
	PaymentAttempts: [x402PaymentAttemptExample],
} satisfies z.infer<typeof listPaymentAttemptsSchemaOutput>;

export const listX402SettlementsResponseExample = {
	Settlements: [x402SettlementExample],
} satisfies z.infer<typeof listSettlementsSchemaOutput>;

// Request examples. privateKey is intentionally omitted so a new key is generated server-side.
export const createX402WalletBodyExample = {
	networkId: x402WalletExample.networkId,
	type: X402EvmWalletType.Purchasing,
} satisfies z.infer<typeof createWalletSchemaInput>;

// The create response returns the generated key once for backup (null when imported).
export const createX402WalletResponseExample = {
	...x402WalletExample,
	privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
} satisfies z.infer<typeof createWalletSchemaOutput>;

export const upsertX402NetworkBodyExample = {
	caip2Id: 'eip155:8453',
	displayName: 'Base',
	rpcUrl: 'https://mainnet.base.org',
	isTestnet: false,
	isEnabled: true,
	defaultAsset: exampleUsdcAsset,
	defaultAssetDecimals: 6,
	facilitatorWalletId: x402FacilitatorWalletExample.id,
};

export const setX402BudgetBodyExample = {
	apiKeyId: 'api_key_id',
	evmWalletId: x402WalletExample.id,
	caip2Network: 'eip155:8453',
	asset: exampleUsdcAsset,
	remainingAmount: '1000000',
};

export const listX402BudgetsQueryExample = {
	apiKeyId: 'api_key_id',
};

export const listX402PaymentAttemptsQueryExample = {
	take: 20,
};

export const listX402SettlementsQueryExample = {
	take: 20,
};

export const createX402PaymentBodyExample = {
	evmWalletId: x402WalletExample.id,
	paymentRequired: {
		x402Version: 1,
		resource: { url: 'https://api.example-agent.com/run' },
		accepts: [
			{
				scheme: 'exact',
				network: 'eip155:8453',
				asset: exampleUsdcAsset,
				amount: '1000000',
				payTo: '0x2222222222222222222222222222222222222222',
				maxTimeoutSeconds: 300,
			},
		],
	},
};

export const createX402PaymentResponseExample = {
	attemptId: 'clx402attempt0001',
	payer: x402WalletExample.address,
	caip2Network: 'eip155:8453',
	asset: exampleUsdcAsset,
	amount: '1000000',
	payTo: '0x2222222222222222222222222222222222222222',
	xPaymentHeader: 'eyJ4NDAyVmVyc2lvbiI6MSwicGF5bG9hZCI6eyJzaWduYXR1cmUiOiIweC4uLiJ9fQ==',
	paymentPayload: {
		x402Version: 1,
		accepted: {
			scheme: 'exact',
			network: 'eip155:8453',
			asset: exampleUsdcAsset,
			amount: '1000000',
			payTo: '0x2222222222222222222222222222222222222222',
			maxTimeoutSeconds: 300,
		},
		payload: { signature: '0x...' },
	},
	paymentPayloadHash: 'b3f1c2a4d5e6f70819203a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
	paymentIdentifier: null,
} satisfies z.infer<typeof createPaymentSchemaOutput>;

export const deleteX402WalletBodyExample = {
	id: x402WalletExample.id,
};

export const deleteX402WalletResponseExample = {
	id: x402WalletExample.id,
};

export const verifyX402BodyExample = {
	supportedPaymentSourceId: 'supported_payment_source_id',
	paymentPayload: {
		x402Version: 1,
		resource: { url: 'https://api.example-agent.com/run' },
		accepted: {
			scheme: 'exact',
			network: 'eip155:8453',
			asset: exampleUsdcAsset,
			amount: '1000000',
			payTo: '0x2222222222222222222222222222222222222222',
			maxTimeoutSeconds: 300,
		},
		payload: { signature: '0x...' },
	},
} satisfies z.infer<typeof verifySettleSchemaInput>;

export const verifyX402ResponseExample = {
	attemptId: x402PaymentAttemptExample.id,
	paymentPayloadHash: 'b3f1c2a4d5e6f70819203a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
	paymentIdentifier: null,
	verifyResponse: {
		isValid: true,
		payer: examplePayer,
	},
} satisfies z.infer<typeof verifySchemaOutput>;

export const settleX402ResponseExample = {
	attemptId: x402PaymentAttemptExample.id,
	paymentPayloadHash: 'b3f1c2a4d5e6f70819203a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f',
	paymentIdentifier: null,
	replay: false,
	settleResponse: {
		success: true,
		payer: examplePayer,
		transaction: '0x4242424242424242424242424242424242424242424242424242424242424242',
		network: 'eip155:8453',
		amount: '1000000',
	},
} satisfies z.infer<typeof settleSchemaOutput>;

// --- Management endpoint examples (wallet update/balance/count, low-balance, analytics) ---

export const updateX402WalletBodyExample = {
	id: x402WalletExample.id,
	note: 'Renamed buyer wallet',
};

export const x402WalletBalanceQueryExample = {
	id: x402WalletExample.id,
};

export const x402WalletBalanceResponseExample = {
	evmWalletId: x402WalletExample.id,
	address: x402WalletExample.address,
	Balances: [
		{
			caip2Network: 'eip155:8453',
			displayName: 'Base',
			native: { symbol: 'ETH', decimals: 18, amount: '12000000000000000' },
			asset: { asset: exampleUsdcAsset, symbol: 'USDC', decimals: 6, amount: '4200000' },
			error: null,
		},
	],
};

export const x402CountResponseExample = { total: 3 };

export const x402LowBalanceRuleExample = {
	id: 'clx402lbrule0001',
	evmWalletId: x402FacilitatorWalletExample.id,
	evmWalletAddress: x402FacilitatorWalletExample.address,
	caip2Network: 'eip155:8453',
	asset: 'native',
	thresholdAmount: '10000000000000000',
	enabled: true,
	status: 'Healthy',
	lastKnownAmount: '50000000000000000',
	lastCheckedAt: exampleDate,
	lastAlertedAt: null,
	createdAt: exampleDate,
	updatedAt: exampleDate,
};

export const listX402LowBalanceRulesResponseExample = {
	Rules: [x402LowBalanceRuleExample],
};

export const setX402LowBalanceRuleBodyExample = {
	evmWalletId: x402FacilitatorWalletExample.id,
	caip2Network: 'eip155:8453',
	asset: 'native',
	thresholdAmount: '10000000000000000',
};

export const updateX402LowBalanceRuleBodyExample = {
	ruleId: x402LowBalanceRuleExample.id,
	thresholdAmount: '20000000000000000',
};

export const deleteX402LowBalanceRuleBodyExample = { ruleId: x402LowBalanceRuleExample.id };

export const deleteX402LowBalanceRuleResponseExample = {
	ruleId: x402LowBalanceRuleExample.id,
	deletedAt: exampleDate,
};

export const x402AnalyticsBodyExample = {
	timeZone: 'Etc/UTC',
};

export const x402AnalyticsResponseExample = {
	periodStart: new Date('2026-05-09T12:00:00.000Z'),
	periodEnd: exampleDate,
	incomeCount: 2,
	spendCount: 1,
	TotalIncome: [{ caip2Network: 'eip155:8453', asset: exampleUsdcAsset, amount: '1500000' }],
	TotalSpend: [{ caip2Network: 'eip155:8453', asset: exampleUsdcAsset, amount: '200000' }],
	Daily: [
		{
			year: 2026,
			month: 6,
			day: 2,
			Income: [{ caip2Network: 'eip155:8453', asset: exampleUsdcAsset, amount: '1500000' }],
			Spend: [{ caip2Network: 'eip155:8453', asset: exampleUsdcAsset, amount: '200000' }],
		},
	],
	Monthly: [
		{
			year: 2026,
			month: 6,
			Income: [{ caip2Network: 'eip155:8453', asset: exampleUsdcAsset, amount: '1500000' }],
			Spend: [{ caip2Network: 'eip155:8453', asset: exampleUsdcAsset, amount: '200000' }],
		},
	],
};
