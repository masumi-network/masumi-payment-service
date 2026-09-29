import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PurchaseErrorType, PurchasingAction } from '@/generated/prisma/client';

const mockCount = jest.fn<(args: { where: { id?: unknown } }) => Promise<number>>();
const mockUpdate = jest.fn<(args: { where: { id: string }; data: unknown }) => Promise<unknown>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hotWallet: { count: mockCount }, purchaseRequest: { update: mockUpdate } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { parkUnfundedPurchases } = await import('./park-unfunded');

const purchase = { id: 'p1', nextActionId: 'a1', inputHash: 'h', isLimitedToHotWallets: false, HotWalletLimit: [] };

beforeEach(() => {
	jest.clearAllMocks();
	mockCount.mockResolvedValue(2);
	mockUpdate.mockResolvedValue({});
});

describe('parkUnfundedPurchases', () => {
	it('parks a purchase once every wallet was evaluated', async () => {
		await parkUnfundedPurchases({ paymentSourceId: 's', purchases: [purchase], evaluatedWalletIds: ['w1', 'w2'] });
		expect(mockUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					NextAction: {
						create: expect.objectContaining({
							requestedAction: PurchasingAction.WaitingForManualAction,
							errorType: PurchaseErrorType.InsufficientFunds,
						}),
					},
				}),
			}),
		);
	});

	it('keeps the purchase queued while a wallet was not evaluated this run', async () => {
		await parkUnfundedPurchases({ paymentSourceId: 's', purchases: [purchase], evaluatedWalletIds: ['w1'] });
		expect(mockUpdate).not.toHaveBeenCalled();
	});

	it('counts only the wallets a pinned purchase may use', async () => {
		mockCount.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
		const pinned = { ...purchase, isLimitedToHotWallets: true, HotWalletLimit: [{ id: 'w2' }] };
		await parkUnfundedPurchases({ paymentSourceId: 's', purchases: [pinned], evaluatedWalletIds: ['w1'] });
		expect(mockUpdate).not.toHaveBeenCalled();
	});
});
