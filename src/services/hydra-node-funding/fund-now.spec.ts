import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Network, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindParticipant = jest.fn() as AnyMock;
const mockFindTransfer = jest.fn() as AnyMock;
const mockCreateTransfer = jest.fn() as AnyMock;
const mockReadLovelaceAt = jest.fn() as AnyMock;

// The claim is one serializable transaction now, so the mock has to offer the
// same client inside it.
const transactionClient = {
	walletFundTransfer: { findFirst: mockFindTransfer, create: mockCreateTransfer },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: { findUniqueOrThrow: mockFindParticipant, findMany: jest.fn() },
		walletFundTransfer: { findFirst: mockFindTransfer, create: mockCreateTransfer },
		$transaction: async (run: (tx: typeof transactionClient) => Promise<unknown>) => await run(transactionClient),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The balance read is internal to the service, so it is mocked at its source:
// the Blockfrost client it asks.
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({
		addressesExtended: async () => ({
			amount: [{ unit: 'lovelace', quantity: (await mockReadLovelaceAt()).toString() }],
		}),
	}),
}));

jest.unstable_mockModule('./node-address', () => ({
	nodeCardanoAddress: () => 'addr_test1_node',
}));

let fundHydraNodeNow: typeof import('./service').fundHydraNodeNow;
// Read from the module rather than repeated as literals: these move when the
// cost of a head's lifecycle changes, and a test asserting a stale number
// reads as a regression when it is only out of date.
let NODE_MINIMUM_LOVELACE: bigint;
let NODE_TARGET_LOVELACE: bigint;

beforeAll(async () => {
	({ fundHydraNodeNow, NODE_MINIMUM_LOVELACE, NODE_TARGET_LOVELACE } = await import('./service'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindParticipant.mockResolvedValue({
		id: 'participant-1',
		hostNodeId: 'node-1',
		cardanoVkey: 'a'.repeat(56),
		walletId: 'wallet-1',
		Wallet: { PaymentSource: { network: Network.Preprod, PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
	});
	mockFindTransfer.mockResolvedValue(null);
	mockCreateTransfer.mockResolvedValue({ id: 'transfer-1' });
	mockReadLovelaceAt.mockResolvedValue(0n);
});

/**
 * The balance does not move until a transfer confirms, so anything that asks
 * again inside that window reads zero and pays a second time. Redeeming an
 * invite funds the node immediately and the periodic cycle funds it too — the
 * two land inside the same window, and every node opened before this guard was
 * paid 10 ADA twice.
 */
describe('fundHydraNodeNow', () => {
	it('funds an empty node', async () => {
		const result = await fundHydraNodeNow('participant-1');

		expect(result.transferredLovelace).toBe(NODE_TARGET_LOVELACE.toString());
		expect(mockCreateTransfer).toHaveBeenCalled();
	});

	it('does not pay again while a transfer is still in flight', async () => {
		mockFindTransfer.mockResolvedValue({ id: 'transfer-0', status: TransactionStatus.Pending });

		const result = await fundHydraNodeNow('participant-1');

		expect(result.transferredLovelace).toBeNull();
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	// The gap that actually bit was *after* confirmation: our row says Confirmed
	// a little before the chain indexer shows the funds, and in that gap the
	// balance still reads zero. Guarding on Pending alone paid every node twice.
	//
	// The two statuses age differently, though. A Confirmed transfer leaves the
	// window once the indexer has certainly caught up; a Pending one never does,
	// because a transfer stuck for an hour may still land, and forgetting it
	// would pay the node a second time for funds that are already on the way.
	it('counts a recently confirmed transfer as still in flight', async () => {
		await fundHydraNodeNow('participant-1');

		const where = mockFindTransfer.mock.calls[0][0].where;
		expect(where.toAddress).toBe('addr_test1_node');

		const [pending, confirmed] = where.OR;
		expect(pending).toEqual({ status: TransactionStatus.Pending });
		expect(confirmed.status).toBe(TransactionStatus.Confirmed);
		expect(confirmed.createdAt.gte).toBeInstanceOf(Date);
	});

	it('does not pay again just after the first transfer confirmed', async () => {
		mockFindTransfer.mockResolvedValue({ id: 'transfer-0', status: TransactionStatus.Confirmed });

		const result = await fundHydraNodeNow('participant-1');

		expect(result.transferredLovelace).toBeNull();
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	it('leaves an already-funded node alone', async () => {
		mockReadLovelaceAt.mockResolvedValue(NODE_MINIMUM_LOVELACE + 1n);

		const result = await fundHydraNodeNow('participant-1');

		expect(result.transferredLovelace).toBeNull();
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});
});
