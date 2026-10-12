import { jest } from '@jest/globals';
import type { Prisma } from '@/generated/prisma/client';

const mockDebug = jest.fn();
const mockError = jest.fn();
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { debug: mockDebug, info: jest.fn(), warn: jest.fn(), error: mockError },
}));

const { reportInitialLockWithoutPurchaseRow } = await import('./missing-purchase-row');

const DETAILS = {
	txHash: 'ab'.repeat(32),
	paymentSourceId: 'payment-source-1',
	blockchainIdentifier: 'blockchain-identifier-1',
	buyerVkey: 'cd'.repeat(28),
};

function clientFinding(wallet: { id: string } | null) {
	const findFirst = jest.fn(async () => wallet);
	return { client: { hotWallet: { findFirst } } as unknown as Pick<Prisma.TransactionClient, 'hotWallet'>, findFirst };
}

describe('reportInitialLockWithoutPurchaseRow', () => {
	beforeEach(() => {
		mockDebug.mockClear();
		mockError.mockClear();
	});

	it('stays at debug for a lock another buyer made', async () => {
		const { client, findFirst } = clientFinding(null);
		await reportInitialLockWithoutPurchaseRow(client, DETAILS);
		expect(findFirst).toHaveBeenCalledWith({
			where: { walletVkey: DETAILS.buyerVkey, type: 'Purchasing' },
			select: { id: true },
		});
		expect(mockDebug).toHaveBeenCalledTimes(1);
		expect(mockError).not.toHaveBeenCalled();
	});

	it('reports an error when this node made the lock but has no purchase row', async () => {
		const { client } = clientFinding({ id: 'hot-wallet-1' });
		await reportInitialLockWithoutPurchaseRow(client, DETAILS);
		expect(mockError).toHaveBeenCalledWith(
			'tx-sync: this node locked funds for a purchase it has no local row for',
			expect.objectContaining({ ...DETAILS, hotWalletId: 'hot-wallet-1' }),
		);
		expect(mockDebug).not.toHaveBeenCalled();
	});
});
