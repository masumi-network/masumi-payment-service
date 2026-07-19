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
let projectBalanceMapFromUnsignedTx: typeof import('./service').projectBalanceMapFromUnsignedTx;
let Address: typeof import('@emurgo/cardano-serialization-lib-nodejs').Address;
let BigNum: typeof import('@emurgo/cardano-serialization-lib-nodejs').BigNum;
let Transaction: typeof import('@emurgo/cardano-serialization-lib-nodejs').Transaction;
let TransactionBody: typeof import('@emurgo/cardano-serialization-lib-nodejs').TransactionBody;
let TransactionHash: typeof import('@emurgo/cardano-serialization-lib-nodejs').TransactionHash;
let TransactionInput: typeof import('@emurgo/cardano-serialization-lib-nodejs').TransactionInput;
let TransactionInputs: typeof import('@emurgo/cardano-serialization-lib-nodejs').TransactionInputs;
let TransactionOutput: typeof import('@emurgo/cardano-serialization-lib-nodejs').TransactionOutput;
let TransactionOutputs: typeof import('@emurgo/cardano-serialization-lib-nodejs').TransactionOutputs;
let TransactionWitnessSet: typeof import('@emurgo/cardano-serialization-lib-nodejs').TransactionWitnessSet;
let Value: typeof import('@emurgo/cardano-serialization-lib-nodejs').Value;

describe('WalletLowBalanceMonitorService', () => {
	let service: InstanceType<typeof WalletLowBalanceMonitorService>;
	const validWalletAddress =
		'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3';
	const otherAddress =
		'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a';

	beforeAll(async () => {
		({ WalletLowBalanceMonitorService, projectBalanceMapFromUnsignedTx } = await import('./service'));
		({
			Address,
			BigNum,
			Transaction,
			TransactionBody,
			TransactionHash,
			TransactionInput,
			TransactionInputs,
			TransactionOutput,
			TransactionOutputs,
			TransactionWitnessSet,
			Value,
		} = await import('@emurgo/cardano-serialization-lib-nodejs'));
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

	it('does not warn on Unknown -> Low', async () => {
		await service.evaluateWalletContext(createWallet(LowBalanceStatus.Unknown), balanceMap(4000000n), 'interval_check');

		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'rule-1',
					status: LowBalanceStatus.Unknown,
				}),
				data: expect.objectContaining({
					status: LowBalanceStatus.Low,
					lastKnownAmount: 4000000n,
				}),
			}),
		);
		expect(mockLogWarn).not.toHaveBeenCalled();
		expect(mockTriggerWalletLowBalance).not.toHaveBeenCalled();
		expect(mockRecordWalletLowBalanceAlert).not.toHaveBeenCalled();
	});

	it('warns once on Healthy -> Low during interval checks and includes wallet identifiers', async () => {
		await service.evaluateWalletContext(createWallet(LowBalanceStatus.Healthy), balanceMap(4000000n), 'interval_check');

		expect(mockLogWarn).toHaveBeenCalledWith(
			'Wallet entered low balance during interval check',
			expect.objectContaining({
				component: 'wallet_low_balance_monitor',
				operation: 'wallet_low_balance_warning',
			}),
			expect.objectContaining({
				network: Network.Preprod,
				wallet_id: 'wallet-1',
				wallet_vkey: 'wallet_vkey',
				wallet_address: 'addr_test1...',
				asset_unit: 'lovelace',
				threshold_amount: '5000000',
				current_amount: '4000000',
				check_source: 'interval_check',
				check_source_label: 'interval check',
			}),
		);
		expect(mockAddEvent).toHaveBeenCalledWith(
			'wallet.low_balance',
			expect.objectContaining({
				network: Network.Preprod,
				wallet_vkey: 'wallet_vkey',
				wallet_address: 'addr_test1...',
			}),
		);
		expect(mockTriggerWalletLowBalance).toHaveBeenCalledWith(
			expect.objectContaining({
				walletId: 'wallet-1',
				walletVkey: 'wallet_vkey',
				walletAddress: 'addr_test1...',
				network: Network.Preprod,
				assetUnit: 'lovelace',
			}),
		);
		expect(mockRecordWalletLowBalanceAlert).toHaveBeenCalledWith({
			network: Network.Preprod,
			asset_unit: 'lovelace',
			wallet_type: HotWalletType.Purchasing,
			check_source: 'interval_check',
			payment_source_type: PaymentSourceType.Web3CardanoV1,
		});
	});

	it('emits low-balance alerts and webhooks for Funding wallets', async () => {
		await service.evaluateWalletContext(
			createWallet(LowBalanceStatus.Healthy, HotWalletType.Funding),
			balanceMap(4000000n),
			'interval_check',
		);

		expect(mockTriggerWalletLowBalance).toHaveBeenCalledWith(
			expect.objectContaining({
				walletId: 'wallet-1',
				walletType: HotWalletType.Funding,
				paymentSourceId: 'payment-source-1',
				assetUnit: 'lovelace',
			}),
		);
		expect(mockRecordWalletLowBalanceAlert).toHaveBeenCalledWith({
			network: Network.Preprod,
			asset_unit: 'lovelace',
			wallet_type: HotWalletType.Funding,
			check_source: 'interval_check',
			payment_source_type: PaymentSourceType.Web3CardanoV1,
		});
	});

	it('warns once on Healthy -> Low during submissions', async () => {
		await service.evaluateWalletContext(createWallet(LowBalanceStatus.Healthy), balanceMap(4000000n), 'submission');

		expect(mockLogWarn).toHaveBeenCalledWith(
			'Wallet entered low balance during submission',
			expect.objectContaining({
				component: 'wallet_low_balance_monitor',
				operation: 'wallet_low_balance_warning',
			}),
			expect.objectContaining({
				check_source: 'submission',
				check_source_label: 'submission',
			}),
		);
		expect(mockRecordWalletLowBalanceAlert).toHaveBeenCalledWith({
			network: Network.Preprod,
			asset_unit: 'lovelace',
			wallet_type: HotWalletType.Purchasing,
			check_source: 'submission',
			payment_source_type: PaymentSourceType.Web3CardanoV1,
		});
	});

	it('does not re-warn on repeated Low -> Low checks', async () => {
		await service.evaluateWalletContext(createWallet(LowBalanceStatus.Low), balanceMap(4000000n), 'interval_check');

		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'rule-1',
					status: LowBalanceStatus.Low,
				}),
				data: expect.objectContaining({
					status: LowBalanceStatus.Low,
				}),
			}),
		);
		expect(mockLogWarn).not.toHaveBeenCalled();
		expect(mockTriggerWalletLowBalance).not.toHaveBeenCalled();
		expect(mockRecordWalletLowBalanceAlert).not.toHaveBeenCalled();
	});

	it('resets silently on Low -> Healthy', async () => {
		await service.evaluateWalletContext(createWallet(LowBalanceStatus.Low), balanceMap(7000000n), 'interval_check');

		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'rule-1',
					status: LowBalanceStatus.Low,
				}),
				data: expect.objectContaining({
					status: LowBalanceStatus.Healthy,
					lastKnownAmount: 7000000n,
				}),
			}),
		);
		expect(mockLogWarn).not.toHaveBeenCalled();
		expect(mockTriggerWalletLowBalance).not.toHaveBeenCalled();
		expect(mockRecordWalletLowBalanceAlert).not.toHaveBeenCalled();
	});

	it('does not emit duplicate alerts when compare-and-set loses the race', async () => {
		mockUpdateMany.mockResolvedValueOnce({ count: 0 });

		await service.evaluateWalletContext(createWallet(LowBalanceStatus.Healthy), balanceMap(4000000n), 'interval_check');

		expect(mockLogWarn).not.toHaveBeenCalled();
		expect(mockTriggerWalletLowBalance).not.toHaveBeenCalled();
		expect(mockRecordWalletLowBalanceAlert).not.toHaveBeenCalled();
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

	it('logs scheduler failures and emits a summary after processing wallets', async () => {
		mockHotWalletFindMany.mockResolvedValue([
			{
				...createWallet(LowBalanceStatus.Healthy),
				Secret: {
					encryptedMnemonic: 'wallet-one-secret',
				},
				PaymentSource: {
					id: 'payment-source-1',
					network: Network.Preprod,
					PaymentSourceConfig: {
						rpcProviderApiKey: 'provider-one',
					},
				},
			},
			{
				...createWallet(LowBalanceStatus.Healthy),
				id: 'wallet-2',
				Secret: {
					encryptedMnemonic: 'wallet-two-secret',
				},
				PaymentSource: {
					id: 'payment-source-2',
					network: Network.Preprod,
					PaymentSourceConfig: {
						rpcProviderApiKey: 'provider-two',
					},
				},
			},
		]);
		mockFetchAddressBalanceMap
			.mockResolvedValueOnce(balanceMap(6000000n))
			.mockRejectedValueOnce(new Error('provider unavailable'));

		await service.runScheduledMonitoringCycle();

		expect(mockLoggerError).toHaveBeenCalledWith(
			'Scheduled low balance monitoring failed for wallet',
			expect.objectContaining({
				component: 'wallet_low_balance_monitor',
				operation: 'scheduled_monitoring_error',
				wallet_id: 'wallet-2',
			}),
		);
		expect(mockLoggerInfo).toHaveBeenCalledWith(
			'Completed scheduled low balance monitoring cycle',
			expect.objectContaining({
				component: 'wallet_low_balance_monitor',
				operation: 'scheduled_monitoring_summary',
				total_wallet_count: 2,
				checked_wallet_count: 1,
				failed_wallet_count: 1,
			}),
		);
	});

	it('skips projected monitoring instead of treating a balance lookup failure as zero', async () => {
		mockHotWalletFindFirst.mockResolvedValueOnce(createBalanceFetchWallet());
		mockFetchAddressBalanceMap.mockRejectedValueOnce(new Error('provider unavailable'));

		await service.evaluateProjectedHotWalletById({
			hotWalletId: 'wallet-1',
			walletAddress: validWalletAddress,
			walletUtxos: [],
			unsignedTx: 'invalid-transaction',
			checkSource: 'submission',
		});

		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockTriggerWalletLowBalance).not.toHaveBeenCalled();
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			'Skipping projected wallet balance evaluation because the confirmed balance is unavailable',
			expect.objectContaining({
				operation: 'projected_balance_skip',
				wallet_id: 'wallet-1',
			}),
		);
	});

	it('projects from the complete confirmed balance while using a UTXO subset to identify consumed inputs', () => {
		const txHash = '11'.repeat(32);
		const inputs = TransactionInputs.new();
		inputs.add(TransactionInput.new(TransactionHash.from_bytes(Buffer.from(txHash, 'hex')), 0));

		const outputs = TransactionOutputs.new();
		outputs.add(TransactionOutput.new(Address.from_bech32(validWalletAddress), Value.new(BigNum.from_str('3500000'))));
		outputs.add(TransactionOutput.new(Address.from_bech32(otherAddress), Value.new(BigNum.from_str('5500000'))));

		const unsignedTx = Buffer.from(
			Transaction.new(
				TransactionBody.new(inputs, outputs, BigNum.from_str('1000000')),
				TransactionWitnessSet.new(),
				undefined,
			).to_bytes(),
		).toString('hex');

		const projectedBalanceMap = projectBalanceMapFromUnsignedTx(
			validWalletAddress,
			[
				{
					input: {
						txHash,
						outputIndex: 0,
					},
					output: {
						amount: [
							{
								unit: 'lovelace',
								quantity: '10000000',
							},
						],
					},
				},
			],
			unsignedTx,
			new Map([
				['lovelace', 10000000n],
				['usdm', 1009494700n],
			]),
		);

		expect(projectedBalanceMap.get('lovelace')).toBe(3500000n);
		expect(projectedBalanceMap.get('usdm')).toBe(1009494700n);
	});
});
