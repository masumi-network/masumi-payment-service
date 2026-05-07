import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, HotWalletType, Network } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindManyRules = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		apiKey: {
			findUnique: mockFindApiKey,
		},
		hotWallet: {
			findFirst: jest.fn(),
			findMany: jest.fn(),
		},
		hotWalletLowBalanceRule: {
			findMany: mockFindManyRules,
			findUnique: jest.fn(),
			create: jest.fn(),
			update: jest.fn(),
			delete: jest.fn(),
			createMany: jest.fn(),
		},
		$transaction: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		ENCRYPTION_KEY: '12345678901234567890',
		LOW_BALANCE_DEFAULT_RULES_MAINNET: [],
		LOW_BALANCE_DEFAULT_RULES_PREPROD: [],
	},
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

jest.unstable_mockModule('@/utils/logger', () => ({
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

jest.unstable_mockModule('@/utils/metrics', () => ({
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

jest.unstable_mockModule('@opentelemetry/api', () => ({
	trace: {
		getActiveSpan: jest.fn(() => null),
	},
}));

const { getWalletLowBalanceRulesEndpointGet } = await import('./low-balance');

describe('getWalletLowBalanceRulesEndpointGet', () => {
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
				id: 'rule-1',
				assetUnit: 'lovelace',
				thresholdAmount: 5000000n,
				enabled: true,
				status: LowBalanceStatus.Low,
				lastKnownAmount: 4000000n,
				lastCheckedAt: new Date('2026-03-10T12:00:00.000Z'),
				lastAlertedAt: new Date('2026-03-10T11:00:00.000Z'),
				HotWallet: {
					id: 'wallet-1',
					walletVkey: 'wallet_vkey',
					walletAddress: 'addr_test1...',
					type: HotWalletType.Purchasing,
					PaymentSource: {
						id: 'payment-source-1',
						network: Network.Preprod,
					},
				},
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
