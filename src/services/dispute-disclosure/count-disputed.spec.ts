import { jest } from '@jest/globals';
import { OnChainState, PaymentSourceType } from '@/generated/prisma/client';

const mockPaymentCount = jest.fn(async () => 0);
const mockPurchaseCount = jest.fn(async () => 0);

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentRequest: { count: mockPaymentCount },
		purchaseRequest: { count: mockPurchaseCount },
	},
}));

const { countActiveDisputedV2Rows } = await import('./lookup');

describe('countActiveDisputedV2Rows', () => {
	beforeEach(() => {
		mockPaymentCount.mockClear();
		mockPurchaseCount.mockClear();
	});

	it('counts only active V2 disputed rows', async () => {
		mockPaymentCount.mockResolvedValueOnce(1);
		mockPurchaseCount.mockResolvedValueOnce(0);

		const total = await countActiveDisputedV2Rows('chain-1');
		expect(total).toBe(1);
		expect(mockPaymentCount).toHaveBeenCalledWith({
			where: {
				blockchainIdentifier: 'chain-1',
				onChainState: OnChainState.Disputed,
				PaymentSource: {
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					deletedAt: null,
				},
			},
		});
	});
});
