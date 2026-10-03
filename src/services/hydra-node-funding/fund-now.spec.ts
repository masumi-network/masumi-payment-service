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
	//
	// And the window is measured from the CONFIRMATION, not from the row's
	// creation. The submitter waits for a hot wallet that is busy doing this
	// head's L2 work, so a transfer routinely sits Pending for longer than the
	// whole window and would already be outside it the moment it confirmed —
	// which puts the indexing gap back exactly where it was. `withdrawNodeFunds`
	// shares this helper, so the same gap let a sweep report `dust` and delete
	// the participant's only signing key with 30 ADA still on its way.
	it('counts a recently confirmed transfer as still in flight', async () => {
		await fundHydraNodeNow('participant-1');

		const where = mockFindTransfer.mock.calls[0][0].where;
		expect(where.toAddress).toBe('addr_test1_node');

		const [pending, confirmed] = where.OR;
		expect(pending).toEqual({ status: TransactionStatus.Pending });
		expect(confirmed.status).toBe(TransactionStatus.Confirmed);
		const [byConfirmation, byCreation] = confirmed.OR;
		expect(byConfirmation.lastCheckedAt.gte).toBeInstanceOf(Date);
		// Only as the fallback for a row nothing stamped.
		expect(byCreation).toEqual({ lastCheckedAt: null, createdAt: { gte: expect.any(Date) } });
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

	// A null transfer meant both "already funded" and "your money is still on
	// the way", and every caller read it as the first. The admin UI announced
	// `Already funded, holding 0.00 tADA` on a node holding nothing, the
	// operator retried Init, got NoSeedInput, and came back to the same
	// sentence — the Pending window has no age bound, deliberately, because the
	// wallet doing L2 work is busy for far longer than any window would allow.
	describe('says which of the two nothing-sent cases happened', () => {
		it('reports a node that needs nothing as sufficient', async () => {
			mockReadLovelaceAt.mockResolvedValue(NODE_MINIMUM_LOVELACE + 1n);

			await expect(fundHydraNodeNow('participant-1')).resolves.toMatchObject({ outcome: 'sufficient' });
		});

		it('reports an unconfirmed earlier transfer as in-flight', async () => {
			mockFindTransfer.mockResolvedValue({ id: 'transfer-0', status: TransactionStatus.Pending });

			await expect(fundHydraNodeNow('participant-1')).resolves.toMatchObject({
				outcome: 'in-flight',
				balanceLovelace: '0',
			});
		});

		it('reports a transfer it started as sent', async () => {
			await expect(fundHydraNodeNow('participant-1')).resolves.toMatchObject({ outcome: 'sent' });
		});
	});

	// The cycle is damped after a failure, because a shortfall the funding wallet
	// cannot cover throws before broadcast and leaves nothing in flight — so the
	// ten-second cycle rebuilt the same doomed transfer forever. An operator
	// pressing Send has already decided to try again, so their request is not.
	it('retries immediately after a failure when an operator asks', async () => {
		await fundHydraNodeNow('participant-1');

		const queries = mockFindTransfer.mock.calls.map((call) => call[0].where);
		expect(queries.some((where) => where.status?.in !== undefined)).toBe(false);
		expect(mockCreateTransfer).toHaveBeenCalled();
	});
});
