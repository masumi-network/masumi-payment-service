import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Network, Prisma, TransactionStatus } from '@/generated/prisma/client';

type FundingSettings = { autoFund: boolean; automaticFundingLimitLovelace: bigint | null };
type TransferCreate = { data: { hotWalletId: string; toAddress: string; lovelaceAmount: bigint } };
const mockFindSettings = jest.fn<(args: object) => Promise<FundingSettings | null>>();
const mockFindTransfer =
	jest.fn<(args: { where: Prisma.WalletFundTransferWhereInput }) => Promise<{ id: string } | null>>();
const mockCreateTransfer = jest.fn<(args: TransferCreate) => Promise<{ id: string }>>();
const mockAggregate = jest.fn<(args: object) => Promise<{ _sum: { lovelaceAmount: bigint | null } }>>();
const mockReadBalance = jest.fn<() => Promise<bigint>>();
const participant = {
	id: 'participant-1',
	hostNodeId: 'node-1',
	cardanoVkey: 'a'.repeat(56),
	walletId: 'wallet-1',
	autoFund: true,
	automaticFundingLimitLovelace: null as bigint | null,
	Wallet: { PaymentSource: { network: Network.Preprod, PaymentSourceConfig: { rpcProviderApiKey: 'key' } } },
};
const transactionClient = {
	hydraLocalParticipant: { findUnique: mockFindSettings },
	walletFundTransfer: { findFirst: mockFindTransfer, create: mockCreateTransfer, aggregate: mockAggregate },
};
const mockTransaction =
	jest.fn<(run: (tx: typeof transactionClient) => Promise<unknown>, options: object) => Promise<unknown>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: {
			findUniqueOrThrow: async () => participant,
			findMany: async () => [participant],
		},
		hydraHeadInvite: { findMany: async () => [] },
		walletFundTransfer: { aggregate: mockAggregate },
		$transaction: mockTransaction,
	},
}));
jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({
		addressesExtended: async () => ({
			amount: [{ unit: 'lovelace', quantity: (await mockReadBalance()).toString() }],
		}),
	}),
}));
jest.unstable_mockModule('./node-address', () => ({ nodeCardanoAddress: () => 'addr_test1_node' }));

let cycle: typeof import('./service').runHydraNodeFundingCycle;
let readPolicy: typeof import('./service').readNodeFundingPolicy;
// The extra argument remains callable against the old source, so baseline tests collect.
let fundNow: (id: string, automatic?: boolean) => Promise<{ outcome: string; transferredLovelace: string | null }>;
let target: bigint;
let historicalTotal: bigint;
beforeAll(async () => {
	const service = await import('./service');
	cycle = service.runHydraNodeFundingCycle;
	readPolicy = service.readNodeFundingPolicy;
	fundNow = service.fundHydraNodeNow;
	target = service.NODE_TARGET_LOVELACE;
});
beforeEach(() => {
	jest.clearAllMocks();
	historicalTotal = 0n;
	participant.autoFund = true;
	participant.automaticFundingLimitLovelace = null;
	mockTransaction.mockImplementation(async (run) => await run(transactionClient));
	mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: null });
	mockFindTransfer.mockResolvedValue(null);
	mockReadBalance.mockResolvedValue(0n);
	mockAggregate.mockImplementation(async () => ({ _sum: { lovelaceAmount: historicalTotal } }));
	mockCreateTransfer.mockImplementation(async ({ data }) => {
		historicalTotal += data.lovelaceAmount;
		return { id: 'transfer-1' };
	});
});

// Settled transfers no longer trigger findFirst; history still counts them for the cap.
// These unit tests verify the transaction query shape, not database concurrency.
describe('optional automatic node funding limits', () => {
	it('keeps unlimited nodes funded after repeated settled transfers', async () => {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			await expect(cycle()).resolves.toMatchObject({ funded: 1 });
		}
		expect(mockCreateTransfer).toHaveBeenCalledTimes(4);
		expect(mockAggregate).not.toHaveBeenCalled();
		expect(mockFindSettings).toHaveBeenCalledTimes(4);
	});

	it('blocks repeated empty-node requests once historical transfers consume the cap', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: target * 2n });
		historicalTotal = target;
		await expect(cycle()).resolves.toMatchObject({ funded: 1 });
		await expect(cycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
		await expect(cycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
		expect(mockCreateTransfer).toHaveBeenCalledTimes(1);
	});

	it('treats zero as a cap rather than unlimited', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: 0n });
		await expect(cycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	it('permits a transfer exactly equal to the remaining limit', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: target * 2n });
		historicalTotal = target;
		await expect(cycle()).resolves.toMatchObject({ funded: 1 });
		expect(mockCreateTransfer).toHaveBeenCalledWith({
			data: { hotWalletId: 'wallet-1', toAddress: 'addr_test1_node', lovelaceAmount: target },
		});
		expect(mockAggregate).toHaveBeenCalledTimes(1);
	});

	it('refuses the whole request when only a partial top-up fits', async () => {
		mockReadBalance.mockResolvedValue(1n);
		mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: target - 2n });
		await expect(cycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	it('counts all Pending and Confirmed transfers to the address in the serializable transaction', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: target });
		mockAggregate.mockResolvedValue({ _sum: { lovelaceAmount: null } });
		await cycle();
		expect(mockAggregate).toHaveBeenCalledWith({
			where: { toAddress: 'addr_test1_node', status: { in: [TransactionStatus.Pending, TransactionStatus.Confirmed] } },
			_sum: { lovelaceAmount: true },
		});
		expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
		});
	});

	it('compares amounts as bigint above the safe integer range', async () => {
		const limit = 9_007_199_254_740_993n;
		historicalTotal = limit - target + 1n;
		mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: limit });
		await expect(cycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	it('applies the cap to immediate automatic invite funding', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: true, automaticFundingLimitLovelace: target });
		historicalTotal = target;
		await expect(fundNow('participant-1', true)).resolves.toMatchObject({
			outcome: 'limit-reached',
			transferredLovelace: null,
		});
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	it('lets manual requests bypass automatic settings and history', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: false, automaticFundingLimitLovelace: 0n });
		await expect(fundNow('participant-1')).resolves.toMatchObject({ outcome: 'sent' });
		expect(mockFindSettings).not.toHaveBeenCalled();
		expect(mockAggregate).not.toHaveBeenCalled();
		expect(mockCreateTransfer).toHaveBeenCalledTimes(1);
	});

	it('rechecks disabled settings after the scheduler selected a stale participant', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: false, automaticFundingLimitLovelace: null });
		await expect(cycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	it('skips a participant removed after the scheduler selected it', async () => {
		mockFindSettings.mockResolvedValue(null);
		await expect(cycle()).resolves.toMatchObject({ funded: 0, skipped: 1 });
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});

	it('reports disabled immediate automatic funding', async () => {
		mockFindSettings.mockResolvedValue({ autoFund: false, automaticFundingLimitLovelace: null });
		await expect(fundNow('participant-1', true)).resolves.toMatchObject({
			outcome: 'disabled',
			transferredLovelace: null,
		});
		expect(mockCreateTransfer).not.toHaveBeenCalled();
	});
});

describe('node automatic funding policy reads', () => {
	it('returns null remaining funding for unlimited nodes while reporting current usage', async () => {
		historicalTotal = 75_000_000n;
		await expect(readPolicy(participant.id)).resolves.toEqual({
			autoFund: true,
			automaticFundingLimitLovelace: null,
			fundedLovelace: '75000000',
			remainingFundingLovelace: null,
		});
	});

	it('subtracts historical usage from the current cap with exact bigint values', async () => {
		participant.automaticFundingLimitLovelace = 9_007_199_254_740_993n;
		historicalTotal = 9_007_199_254_740_991n;
		await expect(readPolicy(participant.id)).resolves.toEqual({
			autoFund: true,
			automaticFundingLimitLovelace: '9007199254740993',
			fundedLovelace: '9007199254740991',
			remainingFundingLovelace: '2',
		});
	});

	it.each([30_000_000n, 60_000_000n])('clamps remaining funding to zero at usage %s', async (used) => {
		participant.autoFund = false;
		participant.automaticFundingLimitLovelace = 30_000_000n;
		historicalTotal = used;
		await expect(readPolicy(participant.id)).resolves.toEqual({
			autoFund: false,
			automaticFundingLimitLovelace: '30000000',
			fundedLovelace: used.toString(),
			remainingFundingLovelace: '0',
		});
	});
});
