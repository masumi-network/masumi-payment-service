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
const mockFindUniqueLowBalanceRule = jest.fn() as AnyMock;
const mockGenerateWalletExtended = jest.fn() as AnyMock;
const mockLoggerInfo = jest.fn() as AnyMock;
const mockLoggerWarn = jest.fn() as AnyMock;
const mockLoggerError = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/db', () => ({
	prisma: {
		$transaction: async (
			callback: (tx: { hotWalletLowBalanceRule: { updateMany: typeof mockUpdateMany } }) => Promise<unknown>,
		) =>
			callback({
				hotWalletLowBalanceRule: {
					updateMany: mockUpdateMany,
				},
			}),
			hotWallet: {
				findFirst: mockHotWalletFindFirst,
				findMany: mockHotWalletFindMany,
			},
			hotWalletLowBalanceRule: {
				create: mockCreateLowBalanceRule,
				update: mockUpdateLowBalanceRule,
				findUnique: mockFindUniqueLowBalanceRule,
				createMany: jest.fn(),
			},
		},
	}));

jest.unstable_mockModule('@/utils/config', () => ({
	CONFIG: {
		LOW_BALANCE_DEFAULT_RULES_MAINNET: [],
		LOW_BALANCE_DEFAULT_RULES_PREPROD: [],
	},
}));

jest.unstable_mockModule('@/utils/logger', () => ({
	logger: {
		info: mockLoggerInfo,
		warn: mockLoggerWarn,
		error: mockLoggerError,
	},
}));

jest.unstable_mockModule('@/utils/logs', () => ({
	logWarn: mockLogWarn,
}));

jest.unstable_mockModule('@/utils/metrics', () => ({
	recordWalletLowBalanceAlert: mockRecordWalletLowBalanceAlert,
}));

jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateWalletExtended: mockGenerateWalletExtended,
}));

jest.unstable_mockModule('@/services/webhook-handler/webhook-events.service', () => ({
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

const { HotWalletType, Network } = await import('@/generated/prisma/client');
const { LowBalanceStatus } = await import('@/generated/prisma/enums');
const { WalletLowBalanceMonitorService, projectBalanceMapFromUnsignedTx } =
	await import('./wallet-low-balance-monitor.service');
const { generateWalletExtended } = await import('@/utils/generator/wallet-generator');
const {
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
} = await import('@emurgo/cardano-serialization-lib-nodejs');

describe('WalletLowBalanceMonitorService', () => {
	const service = new WalletLowBalanceMonitorService();
	const validWalletAddress =
		'addr_test1qr7pdg0u7vy6a5p7cx9my9m0t63f4n48pwmez30t4laguawge7xugp6m5qgr6nnp6wazurtagjva8l9fc3a5a4scx0rq2ymhl3';
	const otherAddress =
		'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a';

	const createWallet = (status: (typeof LowBalanceStatus)[keyof typeof LowBalanceStatus]) => ({
		id: 'wallet-1',
		walletVkey: 'wallet_vkey',
		walletAddress: 'addr_test1...',
		type: HotWalletType.Purchasing,
		PaymentSource: {
			id: 'payment-source-1',
			network: Network.Preprod,
		},
		LowBalanceRules: [
			{
				id: 'rule-1',
				assetUnit: 'lovelace',
				thresholdAmount: 5000000n,
				enabled: true,
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
		status,
		lastKnownAmount: null,
		lastCheckedAt: null,
		lastAlertedAt: null,
	});
	const createBalanceFetchWallet = () => ({
		id: 'wallet-1',
		Secret: {
			encryptedMnemonic: 'encrypted-secret',
		},
		PaymentSource: {
			id: 'payment-source-1',
			network: Network.Preprod,
			PaymentSourceConfig: {
				rpcProviderApiKey: 'provider-key',
			},
		},
	});
	const createMeshUtxos = (quantity: string) => [
		{
			output: {
				amount: [
					{
						unit: 'lovelace',
						quantity,
					},
				],
			},
		},
	];

	beforeEach(() => {
		jest.clearAllMocks();
		mockUpdateMany.mockResolvedValue({ count: 1 });
		mockHotWalletFindFirst.mockReset();
		mockHotWalletFindMany.mockReset();
		mockCreateLowBalanceRule.mockReset();
		mockUpdateLowBalanceRule.mockReset();
		mockFindUniqueLowBalanceRule.mockReset();
		mockGenerateWalletExtended.mockReset();
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
		mockGenerateWalletExtended.mockResolvedValue({
			utxos: createMeshUtxos('4000000'),
		});
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
		expect(generateWalletExtended).toHaveBeenCalledWith(Network.Preprod, 'provider-key', 'encrypted-secret');
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
		mockHotWalletFindFirst
			.mockResolvedValueOnce(createBalanceFetchWallet())
			.mockResolvedValueOnce({
				...createWallet(LowBalanceStatus.Unknown),
				LowBalanceRules: [
					{
						...createWallet(LowBalanceStatus.Unknown).LowBalanceRules[0],
						thresholdAmount: 3000000n,
					},
				],
			});
		mockGenerateWalletExtended.mockResolvedValue({
			utxos: createMeshUtxos('4000000'),
		});
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

		expect(generateWalletExtended).not.toHaveBeenCalled();
		expect(mockHotWalletFindFirst).not.toHaveBeenCalled();
		expect(updatedRule.enabled).toBe(false);
		expect(updatedRule.status).toBe(LowBalanceStatus.Unknown);
	});

	it('re-enables a rule and silently seeds low state without alerting', async () => {
		mockUpdateLowBalanceRule.mockResolvedValue(createRuleRecord(LowBalanceStatus.Unknown));
		mockHotWalletFindFirst
			.mockResolvedValueOnce(createBalanceFetchWallet())
			.mockResolvedValueOnce(createWallet(LowBalanceStatus.Unknown));
		mockGenerateWalletExtended.mockResolvedValue({
			utxos: createMeshUtxos('2000000'),
		});
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

		expect(generateWalletExtended).toHaveBeenCalledWith(Network.Preprod, 'provider-key', 'encrypted-secret');
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
		mockGenerateWalletExtended
			.mockResolvedValueOnce({
				utxos: createMeshUtxos('6000000'),
			})
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

	it('projects the post-submission balance from consumed wallet inputs and wallet outputs', () => {
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
		);

		expect(projectedBalanceMap.get('lovelace')).toBe(3500000n);
	});
});
