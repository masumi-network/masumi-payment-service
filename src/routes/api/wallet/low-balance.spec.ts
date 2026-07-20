import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, HotWalletType, Network } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindManyRules = jest.fn() as AnyMock;
const mockFindWallet = jest.fn() as AnyMock;
const mockFindRule = jest.fn() as AnyMock;
const mockFindUniqueRule = jest.fn() as AnyMock;
const mockCreateRule = jest.fn() as AnyMock;
const mockUpdateRule = jest.fn() as AnyMock;
const mockDeleteRule = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		hotWallet: {
			findFirst: mockFindWallet,
			findMany: jest.fn(),
		},
		hotWalletLowBalanceRule: {
			findMany: mockFindManyRules,
			findFirst: mockFindRule,
			findUnique: mockFindUniqueRule,
			create: jest.fn(),
			update: jest.fn(),
			delete: jest.fn(),
			createMany: jest.fn(),
		},
		$transaction: jest.fn(),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
		LOW_BALANCE_DEFAULT_RULES_MAINNET: [],
		LOW_BALANCE_DEFAULT_RULES_PREPROD: [],
	},
	CONSTANTS: {
		MIN_TX_FEE_BUFFER_LOVELACE: 2000000n,
		MIN_TOPUP_LOVELACE: 5000000n,
	},
	// Needed because the route pulls in the fund-distribution tx builder, which
	// sources its validity window from SERVICE_CONSTANTS via shared/tx-window.
	// A partial mock of this module must enumerate every symbol the transitively
	// loaded graph imports, or the ESM loader fails the whole suite.
	SERVICE_CONSTANTS: {
		RETRY: { maxRetries: 5, backoffMultiplier: 5, initialDelayMs: 500, maxDelayMs: 7500 },
		TRANSACTION: { timeBufferMs: 150000, blockTimeBufferMs: 60000, validitySlotBuffer: 5, resultTimeSlotBuffer: 3 },
		SMART_CONTRACT: {
			collateralAmount: '5000000',
			mintQuantity: '1',
			defaultExUnits: { mem: 7000000, steps: 3000000000 },
		},
		METADATA: { nftLabel: 721, masumiLabel: 674 },
		CARDANO: { NATIVE_TOKEN: 'lovelace' },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/logs', () => ({
	logWarn: jest.fn(),
}));

jest.unstable_mockModule('@masumi/payment-core/metrics', () => ({
	recordWalletLowBalanceAlert: jest.fn(),
}));

jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateWalletExtended: jest.fn(),
}));

jest.unstable_mockModule('@/services/webhooks', () => ({
	webhookEventsService: {
		triggerWalletLowBalance: jest.fn(),
	},
}));

jest.unstable_mockModule('@/services/wallets', () => ({
	serializeLowBalanceRecord: (rule: {
		id: string;
		assetUnit: string;
		thresholdAmount: bigint;
		enabled: boolean;
		topupEnabled: boolean;
		topupAmount: bigint | null;
		status: string;
		lastKnownAmount: bigint | null;
		lastCheckedAt: Date | null;
		lastAlertedAt: Date | null;
	}) => ({
		...rule,
		thresholdAmount: rule.thresholdAmount.toString(),
		topupAmount: rule.topupAmount?.toString() ?? null,
		lastKnownAmount: rule.lastKnownAmount?.toString() ?? null,
	}),
	walletLowBalanceMonitorService: {
		createRuleForWallet: mockCreateRule,
		updateRule: mockUpdateRule,
		deleteRule: mockDeleteRule,
	},
}));

jest.unstable_mockModule('@opentelemetry/api', () => ({
	trace: {
		getActiveSpan: jest.fn(() => null),
	},
}));

const {
	deleteWalletLowBalanceRuleEndpointDelete,
	getWalletLowBalanceRulesEndpointGet,
	patchWalletLowBalanceRuleEndpointPatch,
	postWalletLowBalanceRuleEndpointPost,
} = await import('./low-balance');

const asApiKey = (flags: { canRead: boolean; canPay: boolean; canAdmin: boolean }) => ({
	id: 'api-key-1',
	canRead: flags.canRead,
	canPay: flags.canPay,
	canAdmin: flags.canAdmin,
	status: ApiKeyStatus.Active,
	token: null,
	tokenHash: null,
	tokenHashSecure: 'pbkdf2-placeholder',
	usageLimited: !flags.canAdmin,
	networkLimit: flags.canAdmin ? [] : [Network.Preprod],
	walletScopeEnabled: false,
	WalletScopes: [],
});

const wallet = {
	id: 'wallet-1',
	walletVkey: 'wallet_vkey',
	walletAddress: 'addr_test1...',
	type: HotWalletType.Purchasing,
	PaymentSource: {
		id: 'payment-source-1',
		network: Network.Preprod,
	},
};

const lowBalanceRule = {
	id: 'rule-1',
	assetUnit: 'lovelace',
	thresholdAmount: 5_000_000n,
	enabled: true,
	topupEnabled: true,
	topupAmount: 10_000_000n,
	status: LowBalanceStatus.Low,
	lastKnownAmount: 4_000_000n,
	lastCheckedAt: new Date('2026-03-10T12:00:00.000Z'),
	lastAlertedAt: new Date('2026-03-10T11:00:00.000Z'),
};

describe('getWalletLowBalanceRulesEndpointGet', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('rejects a read key from listing full low-balance rules', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey({ canRead: true, canPay: false, canAdmin: false }));

		const { responseMock } = await testEndpoint({
			endpoint: getWalletLowBalanceRulesEndpointGet,
			requestProps: {
				method: 'GET',
				query: {},
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(401);
		expect(mockFindManyRules).not.toHaveBeenCalled();
	});

	it('allows an admin key to list low-balance rules', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey({ canRead: true, canPay: true, canAdmin: true }));
		mockFindManyRules.mockResolvedValue([
			{
				...lowBalanceRule,
				HotWallet: wallet,
			},
		]);

		const { responseMock } = await testEndpoint({
			endpoint: getWalletLowBalanceRulesEndpointGet,
			requestProps: {
				method: 'GET',
				query: {},
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindManyRules).toHaveBeenCalledTimes(1);
		expect(responseMock._getJSONData()).toEqual({
			status: 'success',
			data: {
				Rules: [
					expect.objectContaining({
						id: 'rule-1',
						walletId: 'wallet-1',
						walletVkey: 'wallet_vkey',
						walletAddress: 'addr_test1...',
						network: Network.Preprod,
					}),
				],
			},
		});
	});
});

describe('low-balance auto top-up validation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey({ canRead: true, canPay: true, canAdmin: true }));
		mockFindWallet.mockResolvedValue(wallet);
		mockFindUniqueRule.mockResolvedValue(null);
		mockFindRule.mockResolvedValue({ ...lowBalanceRule, HotWallet: wallet });
		mockCreateRule.mockResolvedValue(lowBalanceRule);
		mockUpdateRule.mockResolvedValue(lowBalanceRule);
	});

	it('rejects clearing topupAmount while auto top-up remains enabled', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: patchWalletLowBalanceRuleEndpointPatch,
			requestProps: {
				method: 'PATCH',
				body: { ruleId: 'rule-1', topupAmount: null },
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockUpdateRule).not.toHaveBeenCalled();
	});

	it('allows disabling auto top-up and clearing its amount together', async () => {
		mockUpdateRule.mockResolvedValue({
			...lowBalanceRule,
			topupEnabled: false,
			topupAmount: null,
		});

		const { responseMock } = await testEndpoint({
			endpoint: patchWalletLowBalanceRuleEndpointPatch,
			requestProps: {
				method: 'PATCH',
				body: { ruleId: 'rule-1', topupEnabled: false, topupAmount: null },
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockUpdateRule).toHaveBeenCalledWith(
			expect.objectContaining({ ruleId: 'rule-1', topupEnabled: false, topupAmount: null }),
		);
	});

	it('rejects an ADA top-up below the buildable minimum', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: patchWalletLowBalanceRuleEndpointPatch,
			requestProps: {
				method: 'PATCH',
				body: { ruleId: 'rule-1', topupAmount: '1000000' },
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockUpdateRule).not.toHaveBeenCalled();
	});

	it('rejects an invalid native-asset unit when creating an enabled top-up', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: postWalletLowBalanceRuleEndpointPost,
			requestProps: {
				method: 'POST',
				body: {
					walletId: 'wallet-1',
					assetUnit: 'not-a-cardano-asset',
					thresholdAmount: '10',
					enabled: true,
					topupEnabled: true,
					topupAmount: '20',
				},
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockCreateRule).not.toHaveBeenCalled();
	});

	it('rejects enabling auto top-up on a Funding wallet', async () => {
		mockFindWallet.mockResolvedValue({ ...wallet, type: HotWalletType.Funding });

		const { responseMock } = await testEndpoint({
			endpoint: postWalletLowBalanceRuleEndpointPost,
			requestProps: {
				method: 'POST',
				body: {
					walletId: 'wallet-1',
					assetUnit: 'lovelace',
					thresholdAmount: '5000000',
					enabled: true,
					topupEnabled: true,
					topupAmount: '10000000',
				},
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockCreateRule).not.toHaveBeenCalled();
	});

	it('rejects retaining auto top-up while patching a Funding wallet rule', async () => {
		mockFindRule.mockResolvedValue({
			...lowBalanceRule,
			HotWallet: { ...wallet, type: HotWalletType.Funding },
		});

		const { responseMock } = await testEndpoint({
			endpoint: patchWalletLowBalanceRuleEndpointPatch,
			requestProps: {
				method: 'PATCH',
				body: { ruleId: 'rule-1', thresholdAmount: '6000000' },
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockUpdateRule).not.toHaveBeenCalled();
	});

	it('deletes through the service that atomically retires queued top-ups', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: deleteWalletLowBalanceRuleEndpointDelete,
			requestProps: {
				method: 'DELETE',
				query: { ruleId: 'rule-1' },
				headers: { token: 'valid' },
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockDeleteRule).toHaveBeenCalledWith('rule-1');
	});
});
