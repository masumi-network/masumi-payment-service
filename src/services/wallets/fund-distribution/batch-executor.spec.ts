import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockBuildAndSign = jest.fn() as AnyMock;
const mockSubmit = jest.fn() as AnyMock;
const mockFetchAddressBalanceMap = jest.fn() as AnyMock;
const mockIsDefinitiveNodeRejection = jest.fn() as AnyMock;

const mockTxCreate = jest.fn() as AnyMock;
const mockTxUpdate = jest.fn() as AnyMock;
const mockTxDelete = jest.fn() as AnyMock;
const mockHotWalletFindUnique = jest.fn() as AnyMock;
const mockHotWalletUpdate = jest.fn() as AnyMock;
const mockRequestUpdateMany = jest.fn() as AnyMock;

const mockTriggerSent = jest.fn() as AnyMock;
const mockTriggerFailed = jest.fn() as AnyMock;
const mockTriggerLowBalance = jest.fn() as AnyMock;

// Records the order in which the intended-hash write and the broadcast happen.
// The whole point of the pre-submit recording is that it precedes submitTx;
// asserting both merely "were called" would pass even if the order regressed.
const callOrder: string[] = [];

const HotWalletType = { Purchasing: 'Purchasing', Selling: 'Selling', Funding: 'Funding' } as const;
const FundDistributionStatus = {
	Pending: 'Pending',
	Submitted: 'Submitted',
	Confirmed: 'Confirmed',
	Failed: 'Failed',
} as const;
const TransactionStatus = { Pending: 'Pending', Confirmed: 'Confirmed', RolledBack: 'RolledBack' } as const;
const Network = { Mainnet: 'Mainnet', Preprod: 'Preprod' } as const;

jest.unstable_mockModule('@/generated/prisma/client', () => ({
	HotWalletType,
	FundDistributionStatus,
	TransactionStatus,
	Network,
	PaymentSourceType: { Web3CardanoV1: 'Web3CardanoV1', Web3CardanoV2: 'Web3CardanoV2' },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: async (arg: unknown) => {
			if (typeof arg === 'function') {
				return (arg as (tx: unknown) => Promise<unknown>)({
					hotWallet: { findUnique: mockHotWalletFindUnique, update: mockHotWalletUpdate },
					transaction: { create: mockTxCreate },
					fundDistributionRequest: { updateMany: mockRequestUpdateMany },
				});
			}
			return Promise.all(arg as Promise<unknown>[]);
		},
		hotWallet: { update: mockHotWalletUpdate },
		transaction: { update: mockTxUpdate, delete: mockTxDelete },
		fundDistributionRequest: { updateMany: mockRequestUpdateMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONSTANTS: { MIN_TX_FEE_BUFFER_LOVELACE: 2_000_000n },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/blockchain-error-interpreter', () => ({
	interpretBlockchainError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('@masumi/payment-core/submit-error-classifier', () => ({
	isDefinitiveNodeRejection: mockIsDefinitiveNodeRejection,
}));

jest.unstable_mockModule('@/services/shared/address-balance', () => ({
	fetchAddressBalanceMap: mockFetchAddressBalanceMap,
}));

jest.unstable_mockModule('@/services/webhooks', () => ({
	webhookEventsService: {
		triggerFundDistributionSent: mockTriggerSent,
		triggerFundDistributionFailed: mockTriggerFailed,
		triggerWalletLowBalance: mockTriggerLowBalance,
	},
}));

jest.unstable_mockModule('./transaction-builder', () => ({
	buildAndSignFundDistributionTx: mockBuildAndSign,
}));

let processRequestsForFundWallet: typeof import('./batch-executor').processRequestsForFundWallet;

beforeAll(async () => {
	({ processRequestsForFundWallet } = await import('./batch-executor'));
});

const INTENDED_HASH = 'a'.repeat(64);

const fundWallet = {
	id: 'fund-1',
	walletAddress: 'addr_fund',
	walletVkey: 'vkey_fund',
	lowBalanceRuleId: 'rule-1',
	paymentSourceId: 'ps-1',
	paymentSourceType: 'Web3CardanoV1' as const,
	network: 'Preprod' as const,
	rpcProviderApiKey: 'key',
	encryptedMnemonic: 'enc',
	config: {
		warningThreshold: 10_000_000n,
		criticalThreshold: 5_000_000n,
		topupAmount: 20_000_000n,
		batchWindowMs: 300_000,
	},
};

const request = (id: string, amount: bigint) => ({
	id,
	targetWalletId: `target-${id}`,
	targetAddress: `addr_${id}`,
	amount,
});

beforeEach(() => {
	jest.clearAllMocks();
	callOrder.length = 0;

	mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 100_000_000n]]));
	mockHotWalletFindUnique.mockResolvedValue({ lockedAt: null, pendingTransactionId: null });
	mockTxCreate.mockResolvedValue({ id: 'tx-1' });
	mockHotWalletUpdate.mockResolvedValue({});
	mockRequestUpdateMany.mockResolvedValue({ count: 1 });
	mockTxDelete.mockResolvedValue({});
	mockIsDefinitiveNodeRejection.mockReturnValue(false);

	mockTxUpdate.mockImplementation(async (args: any) => {
		if (args?.data?.intendedTxHash) callOrder.push('record-intended');
		if (args?.data?.txHash) callOrder.push('record-txhash');
		return {};
	});
	mockSubmit.mockImplementation(async () => {
		callOrder.push('submit');
		return INTENDED_HASH;
	});
	mockBuildAndSign.mockResolvedValue({
		signedTx: 'signed',
		intendedTxHash: INTENDED_HASH,
		invalidHereafterSlot: 12345,
		submit: mockSubmit,
	});
});

describe('processRequestsForFundWallet', () => {
	it('records intendedTxHash BEFORE broadcasting', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(callOrder).toEqual(['record-intended', 'submit', 'record-txhash']);
		expect(mockTxUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'tx-1' },
				data: expect.objectContaining({ intendedTxHash: INTENDED_HASH, invalidHereafterSlot: 12345n }),
			}),
		);
	});

	it('marks requests Submitted and reports SENT on success', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: { in: ['r1'] } },
				data: expect.objectContaining({ status: FundDistributionStatus.Submitted, txHash: INTENDED_HASH }),
			}),
		);
		expect(mockTriggerSent).toHaveBeenCalledWith(expect.objectContaining({ txHash: INTENDED_HASH }));
	});

	it('links the batch to its Transaction atomically with the lock', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Without this link, reconciliation can resolve the Transaction but
		// nothing maps its verdict back onto the distribution rows.
		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ transactionId: 'tx-1' }) }),
		);
	});

	describe('when submit is ambiguous', () => {
		beforeEach(() => {
			mockIsDefinitiveNodeRejection.mockReturnValue(false);
			mockSubmit.mockImplementation(async () => {
				callOrder.push('submit');
				throw new Error('socket hang up');
			});
		});

		it('leaves the requests Pending for reconciliation rather than failing them', async () => {
			await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

			// The tx may well be on chain. Failing the requests here would let the
			// next cycle rebuild and re-send them -- paying the treasury twice.
			const statuses = mockRequestUpdateMany.mock.calls.map((call: any) => call[0]?.data?.status);
			expect(statuses).not.toContain(FundDistributionStatus.Failed);
		});

		it('does not unlock the wallet or delete the Transaction', async () => {
			await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

			expect(mockTxDelete).not.toHaveBeenCalled();
			expect(mockHotWalletUpdate).not.toHaveBeenCalledWith(
				expect.objectContaining({ data: expect.objectContaining({ lockedAt: null }) }),
			);
		});

		it('does not report an outcome yet', async () => {
			await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

			// Still in flight: reconciliation decides, and the cycle reports then.
			expect(mockTriggerFailed).not.toHaveBeenCalled();
			expect(mockTriggerSent).not.toHaveBeenCalled();
		});
	});

	it('reverts and fails the batch when the node definitively rejects it', async () => {
		mockIsDefinitiveNodeRejection.mockReturnValue(true);
		mockSubmit.mockRejectedValue(new Error('BadInputsUTxO'));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Definitively rejected means it cannot land, so reverting is safe.
		expect(mockTxDelete).toHaveBeenCalledWith({ where: { id: 'tx-1' } });
		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: FundDistributionStatus.Failed }) }),
		);
		expect(mockTriggerFailed).toHaveBeenCalledWith(expect.objectContaining({ txHash: null }));
	});

	it('reverts when build/sign fails, without ever broadcasting', async () => {
		mockBuildAndSign.mockRejectedValue(new Error('insufficient balance'));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockSubmit).not.toHaveBeenCalled();
		expect(mockTxDelete).toHaveBeenCalled();
		expect(mockTriggerFailed).toHaveBeenCalledWith(
			expect.objectContaining({ txHash: null, error: 'insufficient balance' }),
		);
	});

	it('aborts without broadcasting if the intended hash cannot be persisted', async () => {
		mockTxUpdate.mockRejectedValue(new Error('db down'));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Broadcasting without a recorded hash would make an ambiguous outcome
		// unrecoverable, so we must not send.
		expect(mockSubmit).not.toHaveBeenCalled();
		expect(mockTxDelete).toHaveBeenCalled();
	});

	it('defers to reconciliation when the node returns a different hash', async () => {
		mockSubmit.mockResolvedValue('b'.repeat(64));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		// Trust neither hash: do not record a txHash, do not mark Submitted.
		expect(mockTxUpdate).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ txHash: expect.any(String) }) }),
		);
		const statuses = mockRequestUpdateMany.mock.calls.map((call: any) => call[0]?.data?.status);
		expect(statuses).not.toContain(FundDistributionStatus.Submitted);
	});

	it('skips when the fund wallet is already locked', async () => {
		mockHotWalletFindUnique.mockResolvedValue({ lockedAt: new Date(), pendingTransactionId: 'tx-old' });

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).not.toHaveBeenCalled();
	});

	it('sends only the requests the balance covers', async () => {
		// 30 ADA balance - 2 ADA fee buffer = 28 ADA spendable: covers r1, not r2.
		mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 30_000_000n]]));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n), request('r2', 20_000_000n)]);

		expect(mockBuildAndSign).toHaveBeenCalledWith(
			expect.objectContaining({ outputs: [{ address: 'addr_r1', lovelace: 20_000_000n }] }),
		);
	});

	it('reports low balance and sends nothing when the fee buffer is not covered', async () => {
		mockFetchAddressBalanceMap.mockResolvedValue(new Map([['lovelace', 1_000_000n]]));

		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockBuildAndSign).not.toHaveBeenCalled();
		expect(mockTriggerLowBalance).toHaveBeenCalledWith(
			expect.objectContaining({ walletId: 'fund-1', walletType: HotWalletType.Funding }),
		);
	});

	it('reads the balance without decrypting the treasury mnemonic', async () => {
		await processRequestsForFundWallet(fundWallet, [request('r1', 20_000_000n)]);

		expect(mockFetchAddressBalanceMap).toHaveBeenCalledWith(
			expect.objectContaining({ address: 'addr_fund', network: 'Preprod' }),
		);
	});

	it('does nothing when given no requests', async () => {
		await processRequestsForFundWallet(fundWallet, []);

		expect(mockFetchAddressBalanceMap).not.toHaveBeenCalled();
		expect(mockBuildAndSign).not.toHaveBeenCalled();
	});
});
