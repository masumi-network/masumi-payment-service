import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

const mockUpdateMany = jest.fn() as Mock<(...args: any[]) => Promise<{ count: number }>>;
const mockLogWarn = jest.fn();
const mockTriggerWalletLowBalance = jest.fn();
const mockAddEvent = jest.fn();
const mockRecordWalletLowBalanceAlert = jest.fn();

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
			findFirst: jest.fn(),
			findMany: jest.fn(),
		},
		hotWalletLowBalanceRule: {
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
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
	},
}));

jest.unstable_mockModule('@/utils/logs', () => ({
	logWarn: mockLogWarn,
}));

jest.unstable_mockModule('@/utils/metrics', () => ({
	recordWalletLowBalanceAlert: mockRecordWalletLowBalanceAlert,
}));

jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateWalletExtended: jest.fn(),
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
const {
	WalletLowBalanceMonitorService,
	projectBalanceMapFromUnsignedTx,
} = await import('./wallet-low-balance-monitor.service');
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

	beforeEach(() => {
		jest.clearAllMocks();
		mockUpdateMany.mockResolvedValue({ count: 1 });
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

	it('projects the post-submission balance from consumed wallet inputs and wallet outputs', () => {
		const txHash = '11'.repeat(32);
		const inputs = TransactionInputs.new();
		inputs.add(TransactionInput.new(TransactionHash.from_bytes(Buffer.from(txHash, 'hex')), 0));

		const outputs = TransactionOutputs.new();
		outputs.add(
			TransactionOutput.new(
				Address.from_bech32(validWalletAddress),
				Value.new(BigNum.from_str('3500000')),
			),
		);
		outputs.add(
			TransactionOutput.new(
				Address.from_bech32(otherAddress),
				Value.new(BigNum.from_str('5500000')),
			),
		);

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
