import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { claimBlockingHydraTopup } = await import('./blocking');
const { PREPARING_STALE_AFTER_MS } = await import('./stale');

const mockFindFirst = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const tx = { hydraTopup: { findFirst: mockFindFirst, updateMany: mockUpdateMany } } as never;

function preparing(ageMs: number) {
	return { id: 'topup-1', status: 'Preparing', createdAt: new Date(Date.now() - ageMs) };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('claimBlockingHydraTopup', () => {
	it('blocks on a preparation that may still hold a carve on L1', async () => {
		const row = preparing(PREPARING_STALE_AFTER_MS - 60_000);
		mockFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(row);

		await expect(claimBlockingHydraTopup(tx, 'participant-1')).resolves.toBe(row);
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	// Nothing else resolves a Preparing row, so leaving it would wedge deposits.
	it('fails an abandoned preparation and lets the deposit through', async () => {
		mockFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(preparing(PREPARING_STALE_AFTER_MS + 60_000));

		await expect(claimBlockingHydraTopup(tx, 'participant-1')).resolves.toBeNull();
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: 'Preparing' },
			data: { status: 'Failed' },
		});
	});
});
