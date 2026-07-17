import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockLookupChainTx = jest.fn() as AnyMock;
const mockBlocksLatest = jest.fn() as AnyMock;

const mockTransferFindMany = jest.fn() as AnyMock;
const mockTransferUpdateMany = jest.fn() as AnyMock;
const mockTxUpdateMany = jest.fn() as AnyMock;
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockPrismaTransaction = jest.fn() as AnyMock;

const TransactionStatus = {
	Pending: 'Pending',
	Confirmed: 'Confirmed',
	RolledBack: 'RolledBack',
	FailedViaTimeout: 'FailedViaTimeout',
	FailedViaManualReset: 'FailedViaManualReset',
} as const;

// Lock timeout used to decide a never-broadcast orphan is abandoned.
const WALLET_LOCK_TIMEOUT_INTERVAL = 300_000;

jest.unstable_mockModule('@/generated/prisma/client', () => ({
	TransactionStatus,
	Prisma: {},
	Network: { Preprod: 'Preprod', Mainnet: 'Mainnet' },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockPrismaTransaction,
		walletFundTransfer: { findMany: mockTransferFindMany, updateMany: mockTransferUpdateMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/error-string-convert', () => ({
	errorToString: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { WALLET_LOCK_TIMEOUT_INTERVAL },
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ blocksLatest: mockBlocksLatest }),
}));

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupChainTx: mockLookupChainTx,
}));

let checkFundTransferConfirmations: typeof import('./confirmation').checkFundTransferConfirmations;

beforeAll(async () => {
	({ checkFundTransferConfirmations } = await import('./confirmation'));
});

const TX_HASH = 'a'.repeat(64);
const INTENDED_HASH = 'b'.repeat(64);
const INVALID_HEREAFTER_SLOT = 1000n;

type TxOverrides = {
	txHash?: string | null;
	intendedTxHash?: string | null;
	status?: string;
	invalidHereafterSlot?: bigint | null;
	createdAt?: Date;
};

const inFlight = (tx: TxOverrides) => ({
	id: 'transfer-1',
	status: TransactionStatus.Pending,
	transactionId: 'tx-1',
	Transaction: {
		id: 'tx-1',
		txHash: tx.txHash ?? null,
		intendedTxHash: tx.intendedTxHash ?? null,
		status: tx.status ?? TransactionStatus.Pending,
		invalidHereafterSlot: tx.invalidHereafterSlot ?? INVALID_HEREAFTER_SLOT,
		createdAt: tx.createdAt ?? new Date(),
	},
	HotWallet: {
		id: 'wallet-1',
		PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
	},
});

function lastUnlockCall() {
	return mockHotWalletUpdateMany.mock.calls.find((c: any) => c[0]?.data?.lockedAt === null);
}
function transferStatusWrite(status: string) {
	return mockTransferUpdateMany.mock.calls.find((c: any) => c[0]?.data?.status === status);
}

beforeEach(() => {
	jest.clearAllMocks();
	mockTransferUpdateMany.mockResolvedValue({ count: 1 });
	mockTxUpdateMany.mockResolvedValue({ count: 1 });
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
		if (typeof arg === 'function') {
			return (arg as (tx: unknown) => Promise<unknown>)({
				transaction: { updateMany: mockTxUpdateMany },
				walletFundTransfer: { updateMany: mockTransferUpdateMany },
				hotWallet: { updateMany: mockHotWalletUpdateMany },
			});
		}
		return Promise.all(arg as Promise<unknown>[]);
	});
	// Current slot well past the TTL; individual tests lower it when needed.
	mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT) + 10_000 });
});

describe('checkFundTransferConfirmations', () => {
	it('confirms and unlocks (guarded) when the broadcast tx is found on chain', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: TX_HASH })]);
		mockLookupChainTx.mockResolvedValue('found');
		await checkFundTransferConfirmations();
		expect(transferStatusWrite(TransactionStatus.Confirmed)).toBeTruthy();
		expect(lastUnlockCall()?.[0]?.where).toMatchObject({ pendingTransactionId: 'tx-1' });
	});

	it('promotes intendedTxHash to txHash when an ambiguous submit is found on chain', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: null, intendedTxHash: INTENDED_HASH })]);
		mockLookupChainTx.mockResolvedValue('found');
		await checkFundTransferConfirmations();
		expect(mockLookupChainTx.mock.calls[0][0].txHash).toBe(INTENDED_HASH);
		const confirm = mockTransferUpdateMany.mock.calls.find((c: any) => c[0]?.data?.txHash === INTENDED_HASH);
		expect(confirm?.[0]?.data?.status).toBe(TransactionStatus.Confirmed);
	});

	it('does NOTHING but touch on a transient lookup error', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: TX_HASH })]);
		mockLookupChainTx.mockResolvedValue('transient-error');
		await checkFundTransferConfirmations();
		expect(lastUnlockCall()).toBeFalsy();
		expect(transferStatusWrite(TransactionStatus.FailedViaTimeout)).toBeFalsy();
		// only a lastCheckedAt touch
		expect(mockTransferUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { lastCheckedAt: expect.any(Date) } }),
		);
	});

	it('waits (touch only) when not-found but still within TTL + grace', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: TX_HASH })]);
		mockLookupChainTx.mockResolvedValue('not-found');
		mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT) }); // not past TTL
		await checkFundTransferConfirmations();
		expect(transferStatusWrite(TransactionStatus.FailedViaTimeout)).toBeFalsy();
		expect(lastUnlockCall()).toBeFalsy();
	});

	it('fails and unlocks only once not-found AND provably past invalidHereafterSlot + grace', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: TX_HASH })]);
		mockLookupChainTx.mockResolvedValue('not-found');
		mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT) + 10_000 });
		await checkFundTransferConfirmations();
		expect(transferStatusWrite(TransactionStatus.FailedViaTimeout)).toBeTruthy();
		expect(lastUnlockCall()?.[0]?.where).toMatchObject({ pendingTransactionId: 'tx-1' });
	});

	it('does NOT fail a not-found tx when the current slot is unknown (blocksLatest failed)', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: TX_HASH })]);
		mockLookupChainTx.mockResolvedValue('not-found');
		mockBlocksLatest.mockRejectedValue(new Error('blockfrost down'));
		await checkFundTransferConfirmations();
		expect(transferStatusWrite(TransactionStatus.FailedViaTimeout)).toBeFalsy();
		expect(lastUnlockCall()).toBeFalsy();
	});

	it('recovers a never-broadcast orphan only once past the lock timeout', async () => {
		const abandoned = new Date(Date.now() - WALLET_LOCK_TIMEOUT_INTERVAL - 1000);
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: null, intendedTxHash: null, createdAt: abandoned })]);
		await checkFundTransferConfirmations();
		expect(mockLookupChainTx).not.toHaveBeenCalled();
		expect(transferStatusWrite(TransactionStatus.FailedViaTimeout)).toBeTruthy();
		expect(lastUnlockCall()?.[0]?.where).toMatchObject({ pendingTransactionId: 'tx-1' });
	});

	it('leaves a fresh never-broadcast row alone (still inside the build/sign window)', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: null, intendedTxHash: null, createdAt: new Date() })]);
		await checkFundTransferConfirmations();
		expect(mockLookupChainTx).not.toHaveBeenCalled();
		expect(transferStatusWrite(TransactionStatus.FailedViaTimeout)).toBeFalsy();
		expect(lastUnlockCall()).toBeFalsy();
	});

	it('mirrors an already-Confirmed Transaction onto the transfer without a chain call', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: TX_HASH, status: TransactionStatus.Confirmed })]);
		await checkFundTransferConfirmations();
		expect(mockLookupChainTx).not.toHaveBeenCalled();
		expect(transferStatusWrite(TransactionStatus.Confirmed)).toBeTruthy();
	});

	it('mirrors a RolledBack Transaction as a failed transfer without a chain call', async () => {
		mockTransferFindMany.mockResolvedValue([inFlight({ txHash: TX_HASH, status: TransactionStatus.RolledBack })]);
		await checkFundTransferConfirmations();
		expect(mockLookupChainTx).not.toHaveBeenCalled();
		expect(transferStatusWrite(TransactionStatus.FailedViaTimeout)).toBeTruthy();
	});
});
