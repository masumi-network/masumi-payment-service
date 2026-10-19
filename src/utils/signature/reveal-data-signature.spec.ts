import { jest } from '@jest/globals';
import { Network, PaymentSourceType } from '@/generated/prisma/client';

const mockPurchaseFindFirst = jest.fn();
const mockPaymentFindFirst = jest.fn();
const mockDisclosureFindUnique = jest.fn();
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
	});

	it('loads context after dispute when disclosure row exists', async () => {
		mockPurchaseFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce({
				blockchainIdentifier: 'chain-1',
				inputHash: 'in',
				resultHash: 'out',
				smartContractWalletId: 'wallet-1',
				paymentSourceId: 'ps-1',
				PaymentSource: {
					network: Network.Preprod,
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					deletedAt: new Date(),
					AdminWallets: [{ walletAddress: 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' }],
				},
				SellerWallet: { walletVkey: 'vkey' },
			});
		mockPaymentFindFirst.mockResolvedValue(null);
		mockDisclosureFindUnique.mockResolvedValue({ id: 'disc-1' });

		const context = await loadDisputedPaymentContext('chain-1');
		expect(context?.blockchainIdentifier).toBe('chain-1');
		expect(mockPurchaseFindFirst).toHaveBeenCalledTimes(2);
	});
});
