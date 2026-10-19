import { jest } from '@jest/globals';
import { Network, PaymentSourceType } from '@/generated/prisma/client';

const mockPurchaseFindFirst = jest.fn<() => Promise<unknown>>(async () => null);
const mockPaymentFindFirst = jest.fn<() => Promise<unknown>>(async () => null);
const mockDisclosureFindUnique = jest.fn<() => Promise<unknown>>(async () => null);
const mockResolveSeller = jest.fn(async () => 'seller-hot');

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		purchaseRequest: { findFirst: mockPurchaseFindFirst },
		paymentRequest: { findFirst: mockPaymentFindFirst },
		disputeDisclosure: { findUnique: mockDisclosureFindUnique },
	},
}));

jest.unstable_mockModule('@/services/dispute-disclosure/lookup', () => ({
	resolveSellerHotWalletId: mockResolveSeller,
}));

const { loadDisputedPaymentContext } = await import('./reveal-data-signature');

describe('loadDisputedPaymentContext', () => {
	beforeEach(() => {
		mockPurchaseFindFirst.mockReset();
		mockPaymentFindFirst.mockReset();
		mockDisclosureFindUnique.mockReset();
		mockPurchaseFindFirst.mockImplementation(async () => null);
		mockPaymentFindFirst.mockImplementation(async () => null);
		mockDisclosureFindUnique.mockImplementation(async () => null);
	});

	it('loads context after dispute when disclosure row exists', async () => {
		const purchaseRow = {
			blockchainIdentifier: 'chain-1',
			inputHash: 'in',
			resultHash: 'out',
			smartContractWalletId: 'wallet-1',
			paymentSourceId: 'ps-1',
			PaymentSource: {
				network: Network.Preprod,
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				deletedAt: new Date(),
				AdminWallets: [
					{ walletAddress: 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' },
				],
			},
			SellerWallet: { walletVkey: 'vkey' },
		};
		let purchaseCalls = 0;
		mockPurchaseFindFirst.mockImplementation(async () => {
			purchaseCalls += 1;
			return purchaseCalls === 1 ? null : purchaseRow;
		});
		mockDisclosureFindUnique.mockImplementation(async () => ({ id: 'disc-1' }));

		const context = await loadDisputedPaymentContext('chain-1');
		expect(context?.blockchainIdentifier).toBe('chain-1');
		expect(mockPurchaseFindFirst).toHaveBeenCalledTimes(2);
	});
});
