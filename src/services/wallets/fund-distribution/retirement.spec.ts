import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { FundDistributionStatus, HotWalletType } from '@/generated/prisma/client';
import { prepareTargetWalletRemoval, retirePaymentSourceFundDistributions } from './retirement';

type AnyMock = Mock<(...args: any[]) => any>;

const mockRequestCount = jest.fn() as AnyMock;
const mockRequestUpdateMany = jest.fn() as AnyMock;
const mockConfigUpdateMany = jest.fn() as AnyMock;
const mockHotWalletCount = jest.fn() as AnyMock;

const tx = {
	fundDistributionRequest: {
		count: mockRequestCount,
		updateMany: mockRequestUpdateMany,
	},
	fundDistributionConfig: { updateMany: mockConfigUpdateMany },
	hotWallet: { count: mockHotWalletCount },
} as never;

beforeEach(() => {
	jest.clearAllMocks();
	mockRequestCount.mockResolvedValue(0);
	mockRequestUpdateMany.mockResolvedValue({ count: 1 });
	mockConfigUpdateMany.mockResolvedValue({ count: 1 });
	mockHotWalletCount.mockResolvedValue(0);
});

describe('prepareTargetWalletRemoval', () => {
	it('rejects removal while a claimed or submitted top-up exists', async () => {
		mockRequestCount.mockResolvedValue(1);

		await expect(
			prepareTargetWalletRemoval(tx, { paymentSourceId: 'ps-1', walletIds: ['wallet-1'] }),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
	});

	it('fails unclaimed requests before the target is soft-deleted', async () => {
		await prepareTargetWalletRemoval(tx, { paymentSourceId: 'ps-1', walletIds: ['wallet-1'] });

		expect(mockRequestUpdateMany).toHaveBeenCalledWith({
			where: {
				targetWalletId: { in: ['wallet-1'] },
				TargetWallet: { paymentSourceId: 'ps-1', deletedAt: null },
				status: FundDistributionStatus.Pending,
				transactionId: null,
			},
			data: {
				status: FundDistributionStatus.Failed,
				error: 'Distribution cancelled because the target wallet was removed',
			},
		});
	});
});

describe('retirePaymentSourceFundDistributions', () => {
	it('rejects deletion while an active fund wallet remains', async () => {
		mockHotWalletCount.mockResolvedValue(1);

		await expect(retirePaymentSourceFundDistributions(tx, 'ps-1')).rejects.toMatchObject({
			statusCode: 409,
		});
		expect(mockConfigUpdateMany).not.toHaveBeenCalled();
		expect(mockRequestUpdateMany).not.toHaveBeenCalled();
	});

	it('disables funding and cancels only unclaimed requests', async () => {
		await retirePaymentSourceFundDistributions(tx, 'ps-1');

		expect(mockHotWalletCount).toHaveBeenCalledWith({
			where: {
				paymentSourceId: 'ps-1',
				type: HotWalletType.Funding,
				deletedAt: null,
			},
		});
		expect(mockConfigUpdateMany).toHaveBeenCalledWith({
			where: { HotWallet: { paymentSourceId: 'ps-1', deletedAt: null } },
			data: { enabled: false },
		});
		expect(mockRequestUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					FundWallet: { paymentSourceId: 'ps-1' },
					status: FundDistributionStatus.Pending,
					transactionId: null,
				},
			}),
		);
	});
});
