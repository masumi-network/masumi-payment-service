import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Network, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindParticipant = jest.fn() as AnyMock;
const mockFindTransfer = jest.fn() as AnyMock;
const mockCreateTransfer = jest.fn() as AnyMock;
const mockReadLovelaceAt = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: { findUniqueOrThrow: mockFindParticipant, findMany: jest.fn() },
		walletFundTransfer: { findFirst: mockFindTransfer, create: mockCreateTransfer },
	},
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

beforeAll(async () => {
	({ fundHydraNodeNow } = await import('./service'));
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

		expect(result.transferredLovelace).toBe('10000000');
		expect(mockCreateTransfer).toHaveBeenCalled();
	});

	it('does not pay again while a transfer is still in flight', async () => {
		mockFindTransfer.mockResolvedValue({ id: 'transfer-0', status: TransactionStatus.Pending });

		const result = await fundHydraNodeNow('participant-1');

		expect(result.transferredLovelace).toBeNull();
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	// The guard has to span the post-submit window specifically: that is where a
	// hash exists, the chain has not caught up, and the balance still reads zero.
	it('looks for any pending transfer, submitted or not', async () => {
		await fundHydraNodeNow('participant-1');

		expect(mockFindTransfer).toHaveBeenCalledWith({
			where: { toAddress: 'addr_test1_node', status: TransactionStatus.Pending },
		});
	});

	it('leaves an already-funded node alone', async () => {
		mockReadLovelaceAt.mockResolvedValue(9_000_000n);

		const result = await fundHydraNodeNow('participant-1');

		expect(result.transferredLovelace).toBeNull();
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});
});
