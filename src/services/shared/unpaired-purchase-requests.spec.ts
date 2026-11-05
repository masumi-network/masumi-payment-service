import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;
const mockCount = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hotWallet: { count: mockCount },
		purchaseRequest: { update: mockUpdate },
		purchaseActionData: { updateMany: mockUpdateMany },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let settleUnpairedPurchaseRequests: typeof import('./unpaired-purchase-requests').settleUnpairedPurchaseRequests;
beforeAll(async () => {
	({ settleUnpairedPurchaseRequests } = await import('./unpaired-purchase-requests'));
});
beforeEach(() => {
	mockCount.mockReset();
	mockUpdate.mockReset().mockResolvedValue({});
	mockUpdateMany.mockReset().mockResolvedValue({ count: 1 });
});

const usdm = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
const request = (overrides: Partial<import('./unpaired-purchase-requests').UnpairedPurchaseRequest> = {}) => ({
	id: 'pr-1',
	nextActionId: 'action-1',
	inputHash: 'hash',
	isLimitedToHotWallets: false,
	HotWalletLimit: [],
	NextAction: { errorNote: null },
	...overrides,
});
const miss = {
	walletId: 'w1',
	purchaseRequestId: 'pr-1',
	unit: usdm,
	requiredAmount: '900000',
	availableAmount: '400000',
};

describe('settleUnpairedPurchaseRequests', () => {
	it('parks the request as InsufficientFunds when every eligible wallet was free', async () => {
		mockCount.mockResolvedValue(1);
		await settleUnpairedPurchaseRequests({
			paymentSourceId: 'ps',
			requests: [request()],
			freeWallets: [{ id: 'w1' }],
			walletFitMisses: [miss],
		});
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockUpdate.mock.calls[0][0]).toMatchObject({
			where: { id: 'pr-1' },
			data: { NextAction: { create: { errorType: 'InsufficientFunds', errorNote: 'Not enough funds in wallets' } } },
		});
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('notes the shortage on the pending action while another wallet is busy', async () => {
		mockCount.mockResolvedValue(2);
		await settleUnpairedPurchaseRequests({
			paymentSourceId: 'ps',
			requests: [request()],
			freeWallets: [{ id: 'w1' }],
			walletFitMisses: [miss],
		});
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'action-1', requestedAction: 'FundsLockingRequested', errorType: null },
			data: {
				errorNote: expect.stringContaining(
					`Not enough funds in the free purchasing wallets: ${usdm} needs 900000, the best free wallet has 400000 (1 of 2 eligible wallets free).`,
				),
			},
		});
	});

	it('leaves a request alone when its busy wallet produced no fit miss', async () => {
		mockCount.mockResolvedValue(2);
		await settleUnpairedPurchaseRequests({
			paymentSourceId: 'ps',
			requests: [request({ id: 'pr-2', nextActionId: 'action-2' })],
			freeWallets: [{ id: 'w1' }],
			walletFitMisses: [miss],
		});
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('counts only the limited wallets for a wallet-limited request', async () => {
		// Source has 3 purchasing wallets, the request may use only w2, and w2 was free.
		mockCount.mockImplementation(async (args: { where: { id?: { in: string[] } } }) =>
			args.where.id ? args.where.id.in.length : 3,
		);
		await settleUnpairedPurchaseRequests({
			paymentSourceId: 'ps',
			requests: [request({ isLimitedToHotWallets: true, HotWalletLimit: [{ id: 'w2' }] })],
			freeWallets: [{ id: 'w2' }],
			walletFitMisses: [{ ...miss, walletId: 'w2' }],
		});
		expect(mockUpdate).toHaveBeenCalledTimes(1);
	});
});
