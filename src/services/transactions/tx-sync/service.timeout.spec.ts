import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { buildFundsFitMissNote } from './timeout-note';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindTimedOutPurchases = jest.fn() as AnyMock;
const mockUpdatePurchase = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		purchaseRequest: { findMany: mockFindTimedOutPurchases, update: mockUpdatePurchase },
		paymentRequest: { findMany: jest.fn(async () => []) },
		$transaction: jest.fn(async () => null),
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 3, SYNC_LOCK_TIMEOUT_INTERVAL: 180_000 },
	CONSTANTS: { DEFAULT_MAX_PARALLEL_TRANSACTIONS_EXTENDED_LOOKUP: 2 },
}));
jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: (fn: () => Promise<unknown>) => fn(),
}));
jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: (fn: () => Promise<unknown>) => fn(),
}));
jest.unstable_mockModule('@/services/shared', () => ({
	createApiClient: jest.fn(() => ({})),
	withJobLock: (_mutex: unknown, _name: string, fn: () => Promise<void>) => fn(),
}));
jest.unstable_mockModule('./blockchain', () => ({
	getTxsFromCardanoAfterSpecificTx: jest.fn(),
	getExtendedTxInformation: jest.fn(),
}));
jest.unstable_mockModule('./quarantine', () => ({
	QUARANTINE_CHAIN_ORDER: [],
	quarantineTransaction: jest.fn(),
	markCanonicalRolledBackQuarantines: jest.fn(),
	settleCanonicalRolledBackQuarantines: jest.fn(),
}));
jest.unstable_mockModule('./quarantine/fenced-write', () => ({
	createPaymentSourceTxSyncFence: jest.fn(),
	fencePaymentSourceTxSyncVersion: jest.fn(),
	isTxSyncFenceLostError: jest.fn(() => false),
}));
jest.unstable_mockModule('./util', () => ({ extractOnChainTransactionData: jest.fn() }));
jest.unstable_mockModule('./tx', () => ({
	updateInitialTransactions: jest.fn(),
	updateRolledBackTransaction: jest.fn(),
	updateTransaction: jest.fn(),
}));

const { checkLatestTransactions } = await import('./service');

const timedOutRow = (id: string, errorNote: string | null, errorType: string | null = null) => ({
	id,
	nextActionId: `${id}-action`,
	payByTime: BigInt(Date.now() - 3_600_000),
	NextAction: { errorType, errorNote },
	PaymentSource: { HotWallets: [] },
});

describe('purchase lock timeout error type', () => {
	beforeEach(() => {
		mockFindTimedOutPurchases.mockReset();
		mockUpdatePurchase.mockReset();
		mockUpdatePurchase.mockResolvedValue({});
	});

	it('keeps a parked cause, labels a fit-miss note InsufficientFunds, the rest Unknown', async () => {
		const fitMissNote = buildFundsFitMissNote({
			unit: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d',
			requiredAmount: '900000',
			availableAmount: '400000',
			freeWalletCount: 1,
			eligibleWalletCount: 2,
		});
		mockFindTimedOutPurchases.mockResolvedValue([
			timedOutRow('pr-short', fitMissNote),
			timedOutRow('pr-silent', null),
			timedOutRow('pr-parked', 'Not enough funds in wallets', 'InsufficientFunds'),
		]);

		await checkLatestTransactions();

		const createdBy = (id: string) =>
			mockUpdatePurchase.mock.calls.find((call) => call[0].where.id === id)?.[0].data.NextAction.create;
		expect(createdBy('pr-short')).toMatchObject({
			requestedAction: 'WaitingForManualAction',
			errorType: 'InsufficientFunds',
			errorNote: expect.stringContaining(fitMissNote),
		});
		expect(createdBy('pr-silent')).toMatchObject({ errorType: 'Unknown' });
		expect(createdBy('pr-parked')).toMatchObject({ errorType: 'InsufficientFunds' });
	});
});
