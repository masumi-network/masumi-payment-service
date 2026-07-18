import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockBuildAndSign = jest.fn() as AnyMock;
const mockSubmit = jest.fn() as AnyMock;
const mockIsDefinitiveNodeRejection = jest.fn() as AnyMock;

const mockTxCreate = jest.fn() as AnyMock;
const mockTxUpdateMany = jest.fn() as AnyMock;
const mockTxDeleteMany = jest.fn() as AnyMock;
const mockHotWalletUpdateMany = jest.fn() as AnyMock;
const mockTransferUpdateMany = jest.fn() as AnyMock;
const mockTransferFindMany = jest.fn() as AnyMock;
const mockPrismaTransaction = jest.fn() as AnyMock;

const TransactionStatus = {
	Pending: 'Pending',
	Confirmed: 'Confirmed',
	RolledBack: 'RolledBack',
	FailedViaTimeout: 'FailedViaTimeout',
	FailedViaManualReset: 'FailedViaManualReset',
} as const;

// Proves the pre-submit ordering: recording intendedTxHash MUST precede submit,
// else an ambiguous broadcast is unrecoverable. Asserting both were merely
// called would pass even if the order regressed.
const callOrder: string[] = [];

jest.unstable_mockModule('@/generated/prisma/client', () => ({ TransactionStatus, Prisma: {} }));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockPrismaTransaction,
		walletFundTransfer: { findMany: mockTransferFindMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/error-string-convert', () => ({
	errorToString: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

jest.unstable_mockModule('@masumi/payment-core/blockchain-error-interpreter', () => ({
	interpretBlockchainError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

jest.unstable_mockModule('@masumi/payment-core/submit-error-classifier', () => ({
	isDefinitiveNodeRejection: mockIsDefinitiveNodeRejection,
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (fn: () => Promise<unknown>) => fn(),
}));

jest.unstable_mockModule('async-mutex', () => ({
	Mutex: class {
		acquire = async () => () => {};
	},
	tryAcquire: (mutex: { acquire: () => Promise<() => void> }) => mutex,
}));

jest.unstable_mockModule('./transaction-builder', () => ({
	buildAndSignFundTransferTx: mockBuildAndSign,
}));

jest.unstable_mockModule('./assets', () => ({
	readFundTransferAssets: (lovelace: bigint) => [{ unit: 'lovelace', quantity: lovelace }],
}));

let processFundTransfers: typeof import('./service').processFundTransfers;

beforeAll(async () => {
	({ processFundTransfers } = await import('./service'));
});

const INTENDED_HASH = 'a'.repeat(64);

const transferRow = () => ({
	id: 'transfer-1',
	toAddress: 'addr_dest',
	lovelaceAmount: 5_000_000n,
	assets: null,
	status: TransactionStatus.Pending,
	transactionId: null,
	HotWallet: {
		id: 'wallet-1',
		Secret: { encryptedMnemonic: 'enc' },
		PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
	},
});

beforeEach(() => {
	jest.clearAllMocks();
	callOrder.length = 0;

	mockTransferFindMany.mockResolvedValue([transferRow()]);
	mockTxCreate.mockResolvedValue({ id: 'tx-1' });
	mockHotWalletUpdateMany.mockResolvedValue({ count: 1 });
	mockTransferUpdateMany.mockImplementation(async (args: any) => ({ count: args?.where?.id ? 1 : 0 }));
	mockTxDeleteMany.mockResolvedValue({ count: 1 });
	mockTxUpdateMany.mockImplementation(async (args: any) => {
		if (args?.data?.intendedTxHash) callOrder.push('record-intended');
		if (args?.data?.txHash) callOrder.push('record-txhash');
		return { count: 1 };
	});

	mockPrismaTransaction.mockImplementation(async (arg: unknown) => {
		if (typeof arg === 'function') {
			return (arg as (tx: unknown) => Promise<unknown>)({
				hotWallet: { updateMany: mockHotWalletUpdateMany },
				transaction: { create: mockTxCreate, updateMany: mockTxUpdateMany, deleteMany: mockTxDeleteMany },
				walletFundTransfer: { updateMany: mockTransferUpdateMany },
			});
		}
		return Promise.all(arg as Promise<unknown>[]);
	});

	mockIsDefinitiveNodeRejection.mockReturnValue(false);
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

describe('processFundTransfers — money safety', () => {
	it('records intendedTxHash BEFORE broadcasting, and txHash after', async () => {
		await processFundTransfers();
		expect(callOrder).toEqual(['record-intended', 'submit', 'record-txhash']);
	});

	it('claims the wallet with lockedAt+pendingTransactionId=null guard and Serializable', async () => {
		await processFundTransfers();
		const claim = mockHotWalletUpdateMany.mock.calls.find((c: any) => c[0]?.data?.pendingTransactionId === 'tx-1');
		expect(claim?.[0]?.where).toMatchObject({ lockedAt: null, pendingTransactionId: null, deletedAt: null });
	});

	it('does NOT build or submit when the wallet claim loses the race (count 0)', async () => {
		mockHotWalletUpdateMany.mockImplementation(async (args: any) =>
			args?.data?.pendingTransactionId ? { count: 0 } : { count: 1 },
		);
		await processFundTransfers();
		expect(mockBuildAndSign).not.toHaveBeenCalled();
		expect(mockSubmit).not.toHaveBeenCalled();
	});

	it('does NOT build or submit when the transfer was already claimed (count 0)', async () => {
		mockTransferUpdateMany.mockImplementation(async (args: any) =>
			args?.data?.transactionId ? { count: 0 } : { count: 1 },
		);
		await processFundTransfers();
		expect(mockBuildAndSign).not.toHaveBeenCalled();
		expect(mockSubmit).not.toHaveBeenCalled();
	});

	it('reverts (drops the tx, unlocks, fails) when build/sign throws pre-broadcast', async () => {
		mockBuildAndSign.mockRejectedValue(new Error('build boom'));
		await processFundTransfers();
		expect(mockSubmit).not.toHaveBeenCalled();
		expect(mockTxDeleteMany).toHaveBeenCalled();
		// unlock guarded on the owning transaction
		const unlock = mockHotWalletUpdateMany.mock.calls.find((c: any) => c[0]?.data?.lockedAt === null);
		expect(unlock?.[0]?.where).toMatchObject({ pendingTransactionId: 'tx-1' });
	});

	it('discards the signed body WITHOUT submitting when the lease is lost before recording intendedTxHash', async () => {
		// Lease re-fence (updateMany with only lockedAt in data) returns 0.
		mockHotWalletUpdateMany.mockImplementation(async (args: any) => {
			if (args?.data?.pendingTransactionId === 'tx-1') return { count: 1 }; // initial claim
			if (args?.data?.lockedAt && !('pendingTransactionId' in args.data)) return { count: 0 }; // lease lost
			return { count: 1 };
		});
		await processFundTransfers();
		expect(mockSubmit).not.toHaveBeenCalled();
		// lease loss is neither a revert nor a broadcast: the tx is not deleted
		expect(mockTxDeleteMany).not.toHaveBeenCalled();
	});

	it('reverts on a DEFINITIVE node rejection', async () => {
		mockSubmit.mockRejectedValue(new Error('ValueNotConservedUTxO'));
		mockIsDefinitiveNodeRejection.mockReturnValue(true);
		await processFundTransfers();
		expect(mockTxDeleteMany).toHaveBeenCalled();
		const failed = mockTransferUpdateMany.mock.calls.find(
			(c: any) => c[0]?.data?.status === TransactionStatus.FailedViaManualReset,
		);
		expect(failed).toBeTruthy();
	});

	it('leaves the row Pending on an AMBIGUOUS submit — never auto-fails a possibly-landed tx', async () => {
		mockSubmit.mockRejectedValue(new Error('503 Service Unavailable'));
		mockIsDefinitiveNodeRejection.mockReturnValue(false);
		await processFundTransfers();
		// no revert, no fail, no unlock — reconciliation owns it
		expect(mockTxDeleteMany).not.toHaveBeenCalled();
		const failed = mockTransferUpdateMany.mock.calls.find((c: any) =>
			[TransactionStatus.FailedViaManualReset, TransactionStatus.FailedViaTimeout].includes(c[0]?.data?.status),
		);
		expect(failed).toBeFalsy();
		const unlock = mockHotWalletUpdateMany.mock.calls.find((c: any) => c[0]?.data?.lockedAt === null);
		expect(unlock).toBeFalsy();
	});

	it('defers to reconciliation when the node txHash diverges from intendedTxHash', async () => {
		mockSubmit.mockImplementation(async () => {
			callOrder.push('submit');
			return 'f'.repeat(64); // node returns a hash we did not compute
		});
		await processFundTransfers();
		// never records the broadcast txHash, never fails
		expect(callOrder).toEqual(['record-intended', 'submit']);
		const recordedTxHash = mockTxUpdateMany.mock.calls.find((c: any) => c[0]?.data?.txHash);
		expect(recordedTxHash).toBeFalsy();
	});

	it('only scans Pending transfers with no transaction on a free wallet', async () => {
		await processFundTransfers();
		expect(mockTransferFindMany.mock.calls[0][0].where).toMatchObject({
			status: TransactionStatus.Pending,
			transactionId: null,
			HotWallet: { lockedAt: null, pendingTransactionId: null, deletedAt: null },
		});
	});
});
