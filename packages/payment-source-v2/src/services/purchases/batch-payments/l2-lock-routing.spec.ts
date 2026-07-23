import { describe, expect, it, jest } from '@jest/globals';
import { PaymentSourceType } from '@/generated/prisma/client';

const mockPaymentSourceFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>().mockResolvedValue([]);

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentSource: { findMany: mockPaymentSourceFindMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { processL2PurchaseLocks } = await import('./l2-lock');

describe('processL2PurchaseLocks routing scope', () => {
	it('does not route requests while their payment source is disabled or synchronizing', async () => {
		await processL2PurchaseLocks();

		expect(mockPaymentSourceFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					deletedAt: null,
					syncInProgress: false,
					disablePaymentAt: null,
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
				},
			}),
		);
	});
});
