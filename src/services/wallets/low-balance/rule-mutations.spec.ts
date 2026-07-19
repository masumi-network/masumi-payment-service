import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as Mock<(...args: any[]) => Promise<{ count: number }>>;
const mockLogWarn = jest.fn();
const mockTriggerWalletLowBalance = jest.fn();
const mockAddEvent = jest.fn();
const mockRecordWalletLowBalanceAlert = jest.fn();
const mockHotWalletFindFirst = jest.fn() as AnyMock;
const mockHotWalletFindMany = jest.fn() as AnyMock;
const mockCreateLowBalanceRule = jest.fn() as AnyMock;
const mockUpdateLowBalanceRule = jest.fn() as AnyMock;
const mockDeleteLowBalanceRule = jest.fn() as AnyMock;
const mockFindUniqueLowBalanceRule = jest.fn() as AnyMock;
const mockDistributionUpdateMany = jest.fn() as AnyMock;
const mockFetchAddressBalanceMap = jest.fn() as AnyMock;
const mockLoggerInfo = jest.fn() as AnyMock;
const mockLoggerWarn = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;

const HotWalletType = {
	Purchasing: 'Purchasing',
	Selling: 'Selling',
	Funding: 'Funding',
} as const;

const Network = {
	Mainnet: 'Mainnet',
	Preprod: 'Preprod',
} as const;

const LowBalanceStatus = {
	Unknown: 'Unknown',
	Low: 'Low',
	Healthy: 'Healthy',
} as const;

const PaymentSourceType = {
	Web3CardanoV1: 'Web3CardanoV1',
	Web3CardanoV2: 'Web3CardanoV2',
} as const;

jest.unstable_mockModule('@/generated/prisma/client', () => ({
	HotWalletType,
	Network,
	PaymentSourceType,
	FundDistributionPriority: { Warning: 'Warning', Critical: 'Critical' },
	FundDistributionStatus: { Pending: 'Pending', Submitted: 'Submitted', Confirmed: 'Confirmed', Failed: 'Failed' },
	TransactionStatus: { Pending: 'Pending', Submitted: 'Submitted', Confirmed: 'Confirmed' },
}));

jest.unstable_mockModule('@/generated/prisma/enums', () => ({
	LowBalanceStatus,
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: async (
			callback: (tx: {
				hotWalletLowBalanceRule: {
					updateMany: typeof mockUpdateMany;
					update: typeof mockUpdateLowBalanceRule;
					delete: typeof mockDeleteLowBalanceRule;
				};
				fundDistributionRequest: { updateMany: typeof mockDistributionUpdateMany };
			}) => Promise<unknown>,
		) =>
			callback({
				hotWalletLowBalanceRule: {
					updateMany: mockUpdateMany,
					update: mockUpdateLowBalanceRule,
					delete: mockDeleteLowBalanceRule,
				},
				fundDistributionRequest: { updateMany: mockDistributionUpdateMany },
			}),
		hotWallet: {
			findFirst: mockHotWalletFindFirst,
			findMany: mockHotWalletFindMany,
		},
		hotWalletLowBalanceRule: {
			create: mockCreateLowBalanceRule,
			update: mockUpdateLowBalanceRule,
			delete: mockDeleteLowBalanceRule,
			findUnique: mockFindUniqueLowBalanceRule,
			createMany: jest.fn(),
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: {
		LOW_BALANCE_DEFAULT_RULES_MAINNET: [],
		LOW_BALANCE_DEFAULT_RULES_PREPROD: [],
	},
	CONSTANTS: {
		MIN_TX_FEE_BUFFER_LOVELACE: 2000000n,
	},
}));

jest.unstable_mockModule('@/services/wallets/fund-distribution', () => ({
	fundDistributionService: {
		requestTopup: jest.fn(),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: mockLoggerInfo,
		warn: mockLoggerWarn,
		error: mockLoggerError,
	},
}));

jest.unstable_mockModule('@/utils/logs', () => ({
	logWarn: mockLogWarn,
}));

jest.unstable_mockModule('@masumi/payment-core/metrics', () => ({
	recordWalletLowBalanceAlert: mockRecordWalletLowBalanceAlert,
}));

jest.unstable_mockModule('@/services/shared/address-balance', () => ({
	fetchAddressBalanceMap: mockFetchAddressBalanceMap,
}));

jest.unstable_mockModule('@/services/webhooks', () => ({
	webhookEventsService: {
		triggerWalletLowBalance: mockTriggerWalletLowBalance,
	},
}));

jest.unstable_mockModule('@opentelemetry/api', () => ({
	trace: {
		getActiveSpan: jest.fn(() => ({
			addEvent: mockAddEvent,
		})),
	},
}));

let WalletLowBalanceMonitorService: typeof import('./service').WalletLowBalanceMonitorService;

describe('WalletLowBalanceMonitorService rule mutations', () => {
	let service: InstanceType<typeof WalletLowBalanceMonitorService>;

	beforeAll(async () => {
		({ WalletLowBalanceMonitorService } = await import('./service'));
	});

	beforeEach(() => {
		service = new WalletLowBalanceMonitorService();
	});

	const createWallet = (
		status: (typeof LowBalanceStatus)[keyof typeof LowBalanceStatus],
		type: (typeof HotWalletType)[keyof typeof HotWalletType] = HotWalletType.Purchasing,
	) => ({
		id: 'wallet-1',
		walletVkey: 'wallet_vkey',
		walletAddress: 'addr_test1...',
		type,
		PaymentSource: {
			id: 'payment-source-1',
			network: Network.Preprod,
			paymentSourceType: PaymentSourceType.Web3CardanoV1,
		},
		LowBalanceRules: [
			{
				id: 'rule-1',
				assetUnit: 'lovelace',
				thresholdAmount: 5000000n,
				enabled: true,
				topupEnabled: false,
				topupAmount: null,
				status,
				lastKnownAmount: null,
				lastCheckedAt: null,
				lastAlertedAt: null,
			},
		],
	});

	const balanceMap = (amount: bigint) => new Map<string, bigint>([['lovelace', amount]]);
	const createRuleRecord = (status: (typeof LowBalanceStatus)[keyof typeof LowBalanceStatus], enabled = true) => ({
		id: 'rule-1',
		hotWalletId: 'wallet-1',
		assetUnit: 'lovelace',
		thresholdAmount: 5000000n,
		enabled,
		topupEnabled: false,
		topupAmount: null,
		status,
		lastKnownAmount: null,
		lastCheckedAt: null,
		lastAlertedAt: null,
	});
	const createBalanceFetchWallet = () => ({
		id: 'wallet-1',
		walletAddress: 'addr_test1...',
		PaymentSource: {
			id: 'payment-source-1',
			network: Network.Preprod,
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
		},
	});

	beforeEach(() => {
		jest.clearAllMocks();
		mockUpdateMany.mockResolvedValue({ count: 1 });
		mockHotWalletFindFirst.mockReset();
		mockHotWalletFindMany.mockReset();
		mockCreateLowBalanceRule.mockReset();
		mockUpdateLowBalanceRule.mockReset();
		mockDeleteLowBalanceRule.mockReset();
		mockFindUniqueLowBalanceRule.mockReset();
		mockFetchAddressBalanceMap.mockReset();
		mockDistributionUpdateMany.mockResolvedValue({ count: 1 });
	});

	it('creates a rule and silently seeds low state when current balance is already below threshold', async () => {
		mockCreateLowBalanceRule.mockResolvedValue(createRuleRecord(LowBalanceStatus.Unknown));
		mockHotWalletFindFirst
			.mockResolvedValueOnce(createBalanceFetchWallet())
			.mockResolvedValueOnce(createWallet(LowBalanceStatus.Unknown));
		mockFetchAddressBalanceMap.mockResolvedValue(balanceMap(4000000n));
		mockFindUniqueLowBalanceRule.mockResolvedValue({
			...createRuleRecord(LowBalanceStatus.Low),
			lastKnownAmount: 4000000n,
			lastCheckedAt: new Date('2026-03-10T12:00:00.000Z'),
			lastAlertedAt: null,
		});

		const createdRule = await service.createRuleForWallet({
			hotWalletId: 'wallet-1',
			assetUnit: 'lovelace',
			thresholdAmount: 5000000n,
			enabled: true,
		});

		expect(mockCreateLowBalanceRule).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: LowBalanceStatus.Unknown,
					lastKnownAmount: null,
					lastCheckedAt: null,
					lastAlertedAt: null,
				}),
			}),
		);
		expect(mockFetchAddressBalanceMap).toHaveBeenCalledWith({
			network: Network.Preprod,
			rpcProviderApiKey: 'provider-key',
			address: 'addr_test1...',
		});
		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'rule-1',
					status: LowBalanceStatus.Unknown,
				}),
				data: expect.objectContaining({
					status: LowBalanceStatus.Low,
					lastKnownAmount: 4000000n,
					lastAlertedAt: null,
				}),
			}),
		);
		expect(mockLogWarn).not.toHaveBeenCalled();
		expect(createdRule.status).toBe(LowBalanceStatus.Low);
		expect(createdRule.lastAlertedAt).toBeNull();
	});

	it('resets a low rule and silently reseeds it healthy when the threshold is lowered', async () => {
		mockUpdateLowBalanceRule.mockResolvedValue({
			...createRuleRecord(LowBalanceStatus.Unknown),
			thresholdAmount: 3000000n,
		});
		mockHotWalletFindFirst.mockResolvedValueOnce(createBalanceFetchWallet()).mockResolvedValueOnce({
			...createWallet(LowBalanceStatus.Unknown),
			LowBalanceRules: [
				{
					...createWallet(LowBalanceStatus.Unknown).LowBalanceRules[0],
					thresholdAmount: 3000000n,
				},
			],
		});
		mockFetchAddressBalanceMap.mockResolvedValue(balanceMap(4000000n));
		mockFindUniqueLowBalanceRule.mockResolvedValue({
			...createRuleRecord(LowBalanceStatus.Healthy),
			thresholdAmount: 3000000n,
			lastKnownAmount: 4000000n,
			lastCheckedAt: new Date('2026-03-10T12:01:00.000Z'),
			lastAlertedAt: null,
		});

		const updatedRule = await service.updateRule({
			ruleId: 'rule-1',
			thresholdAmount: 3000000n,
		});

		expect(mockUpdateLowBalanceRule).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					thresholdAmount: 3000000n,
					status: LowBalanceStatus.Unknown,
					lastKnownAmount: null,
					lastCheckedAt: null,
					lastAlertedAt: null,
				}),
			}),
		);
		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'rule-1',
					status: LowBalanceStatus.Unknown,
				}),
				data: expect.objectContaining({
					status: LowBalanceStatus.Healthy,
					lastKnownAmount: 4000000n,
					lastAlertedAt: null,
				}),
			}),
		);
		expect(mockLogWarn).not.toHaveBeenCalled();
		expect(updatedRule.status).toBe(LowBalanceStatus.Healthy);
		expect(updatedRule.lastAlertedAt).toBeNull();
	});

	it('disables a rule without re-querying the wallet balance', async () => {
		mockUpdateLowBalanceRule.mockResolvedValue(createRuleRecord(LowBalanceStatus.Unknown, false));
		mockFindUniqueLowBalanceRule.mockResolvedValue(createRuleRecord(LowBalanceStatus.Unknown, false));

		const updatedRule = await service.updateRule({
			ruleId: 'rule-1',
			enabled: false,
		});

		expect(mockFetchAddressBalanceMap).not.toHaveBeenCalled();
		expect(mockHotWalletFindFirst).not.toHaveBeenCalled();
		expect(updatedRule.enabled).toBe(false);
		expect(updatedRule.status).toBe(LowBalanceStatus.Unknown);
	});

	it('retires an unclaimed top-up atomically when a rule changes', async () => {
		mockUpdateLowBalanceRule.mockResolvedValue(createRuleRecord(LowBalanceStatus.Unknown, false));
		mockFindUniqueLowBalanceRule.mockResolvedValue(createRuleRecord(LowBalanceStatus.Unknown, false));

		await service.updateRule({
			ruleId: 'rule-1',
			enabled: false,
		});

		expect(mockDistributionUpdateMany).toHaveBeenCalledWith({
			where: {
				targetWalletId: 'wallet-1',
				assetUnit: 'lovelace',
				status: 'Pending',
				fundWalletId: null,
				transactionId: null,
			},
			data: {
				status: 'Failed',
				error: 'Distribution cancelled because its low-balance rule changed',
			},
		});
	});

	it('deletes a rule and retires its unclaimed top-up in one transaction', async () => {
		mockDeleteLowBalanceRule.mockResolvedValue({
			hotWalletId: 'wallet-1',
			assetUnit: 'lovelace',
		});

		await service.deleteRule('rule-1');

		expect(mockDeleteLowBalanceRule).toHaveBeenCalledWith({
			where: { id: 'rule-1' },
			select: {
				hotWalletId: true,
				assetUnit: true,
			},
		});
		expect(mockDistributionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					targetWalletId: 'wallet-1',
					assetUnit: 'lovelace',
					fundWalletId: null,
					transactionId: null,
				}),
				data: expect.objectContaining({
					status: 'Failed',
					error: 'Distribution cancelled because its low-balance rule was deleted',
				}),
			}),
		);
	});

	it('maps a concurrent-delete P2025 to a 404 and rethrows other failures unchanged', async () => {
		// The route pre-checks existence, so P2025 means a concurrent delete won
		// the race — a missing row for the client, not a server fault.
		mockDeleteLowBalanceRule.mockRejectedValueOnce(
			Object.assign(new Error('Record to delete does not exist.'), { code: 'P2025' }),
		);

		await expect(service.deleteRule('rule-1')).rejects.toMatchObject({
			status: 404,
			statusCode: 404,
			message: 'Low balance rule not found',
		});

		// Anything else is a real fault and must surface unchanged.
		const infrastructureFailure = Object.assign(new Error('connection reset'), { code: 'P1001' });
		mockDeleteLowBalanceRule.mockRejectedValueOnce(infrastructureFailure);

		await expect(service.deleteRule('rule-1')).rejects.toBe(infrastructureFailure);
	});

	it('re-enables a rule and silently seeds low state without alerting', async () => {
		mockUpdateLowBalanceRule.mockResolvedValue(createRuleRecord(LowBalanceStatus.Unknown));
		mockHotWalletFindFirst
			.mockResolvedValueOnce(createBalanceFetchWallet())
			.mockResolvedValueOnce(createWallet(LowBalanceStatus.Unknown));
		mockFetchAddressBalanceMap.mockResolvedValue(balanceMap(2000000n));
		mockFindUniqueLowBalanceRule.mockResolvedValue({
			...createRuleRecord(LowBalanceStatus.Low),
			lastKnownAmount: 2000000n,
			lastCheckedAt: new Date('2026-03-10T12:02:00.000Z'),
			lastAlertedAt: null,
		});

		const updatedRule = await service.updateRule({
			ruleId: 'rule-1',
			enabled: true,
		});

		expect(mockFetchAddressBalanceMap).toHaveBeenCalledWith({
			network: Network.Preprod,
			rpcProviderApiKey: 'provider-key',
			address: 'addr_test1...',
		});
		expect(mockLogWarn).not.toHaveBeenCalled();
		expect(updatedRule.status).toBe(LowBalanceStatus.Low);
		expect(updatedRule.lastAlertedAt).toBeNull();
	});
});
