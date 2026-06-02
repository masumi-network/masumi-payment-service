import { X402PaymentDirection, X402PaymentStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import {
	budgetSchema,
	createPaymentSchemaOutput,
	listBudgetSchemaOutput,
	listNetworksSchemaOutput,
	listPaymentAttemptsSchemaOutput,
	listSettlementsSchemaOutput,
	listWalletsSchemaOutput,
	walletSchemaOutput,
	x402NetworkSchema,
	x402PaymentAttemptSchema,
	x402SettlementSchema,
} from './schemas';

const exampleDate = new Date('2026-06-02T12:00:00.000Z');
const exampleUsdcAsset = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const examplePayer = '0x3333333333333333333333333333333333333333';

export const x402WalletExample = {
	id: 'clmanagedwallet0001',
	address: '0x1111111111111111111111111111111111111111',
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
	facilitatorWalletId: x402WalletExample.id,
	createdById: 'api_key_id',
	createdAt: exampleDate,
	updatedAt: exampleDate,
} satisfies z.infer<typeof x402NetworkSchema>;

export const x402BudgetExample = {
	id: 'clx402budget0001',
	apiKeyId: 'api_key_id',
	evmWalletId: x402WalletExample.id,
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
	evmWalletId: null,
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

export const listX402WalletsResponseExample = {
	Wallets: [x402WalletExample],
} satisfies z.infer<typeof listWalletsSchemaOutput>;

export const listX402NetworksResponseExample = {
	Networks: [x402NetworkExample],
} satisfies z.infer<typeof listNetworksSchemaOutput>;

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
export const createX402WalletBodyExample = {};

export const upsertX402NetworkBodyExample = {
	caip2Id: 'eip155:8453',
	displayName: 'Base',
	rpcUrl: 'https://mainnet.base.org',
	isTestnet: false,
	isEnabled: true,
	defaultAsset: exampleUsdcAsset,
	facilitatorWalletId: x402WalletExample.id,
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
