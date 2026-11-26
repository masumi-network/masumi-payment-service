import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { PaymentSourceType } from '@/generated/prisma/enums';

const mockFindFirst = jest.fn() as Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { paymentSource: { findFirst: mockFindFirst } },
}));
jest.unstable_mockModule('@/generated/prisma/client', async () => await import('@/generated/prisma/enums'));

const { isPaymentSourceTypeInUse, resetPaymentSourceUsageCache } = await import('./index');

const V1 = PaymentSourceType.Web3CardanoV1;
const V2 = PaymentSourceType.Web3CardanoV2;

describe('isPaymentSourceTypeInUse', () => {
	let now = 1_000_000;

	beforeEach(() => {
		resetPaymentSourceUsageCache();
		mockFindFirst.mockReset();
		now = 1_000_000;
		jest.spyOn(performance, 'now').mockImplementation(() => now);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('asks again after the not-in-use cache expires, so a source added at runtime starts its jobs', async () => {
		mockFindFirst.mockResolvedValue(null);
		expect(await isPaymentSourceTypeInUse(V2)).toBe(false);

		now += 29_000;
		expect(await isPaymentSourceTypeInUse(V2)).toBe(false);
		expect(mockFindFirst).toHaveBeenCalledTimes(1);

		mockFindFirst.mockResolvedValue({ id: 'source-1' });
		now += 2_000;
		expect(await isPaymentSourceTypeInUse(V2)).toBe(true);
		expect(mockFindFirst).toHaveBeenCalledTimes(2);
	});

	it('stays true without asking again once a source was seen', async () => {
		mockFindFirst.mockResolvedValue({ id: 'source-1' });
		expect(await isPaymentSourceTypeInUse(V1)).toBe(true);

		mockFindFirst.mockResolvedValue(null);
		now += 3_600_000;
		expect(await isPaymentSourceTypeInUse(V1)).toBe(true);
		expect(mockFindFirst).toHaveBeenCalledTimes(1);
	});

	it('counts soft-deleted sources and keeps each type separate', async () => {
		mockFindFirst.mockImplementation(async ({ where }: { where: { paymentSourceType: PaymentSourceType } }) =>
			where.paymentSourceType === V1 ? { id: 'deleted-v1' } : null,
		);

		expect(await isPaymentSourceTypeInUse(V1)).toBe(true);
		expect(await isPaymentSourceTypeInUse(V2)).toBe(false);
		expect(mockFindFirst).toHaveBeenCalledWith({ where: { paymentSourceType: V1 }, select: { id: true } });
	});

	it('does not let an older miss override a newer hit during the first source creation', async () => {
		let resolveOlder: (value: null) => void = () => {};
		mockFindFirst.mockImplementationOnce(() => new Promise((resolve) => (resolveOlder = resolve)));
		mockFindFirst.mockResolvedValueOnce({ id: 'source-1' });

		const older = isPaymentSourceTypeInUse(V2);
		expect(await isPaymentSourceTypeInUse(V2)).toBe(true);
		resolveOlder(null);

		expect(await older).toBe(true);
		expect(await isPaymentSourceTypeInUse(V2)).toBe(true);
	});

	it('measures the cache on a monotonic clock, so a wall-clock step back does not extend a miss', async () => {
		const wallClock = jest.spyOn(Date, 'now').mockReturnValue(10_000_000);
		mockFindFirst.mockResolvedValue(null);
		expect(await isPaymentSourceTypeInUse(V1)).toBe(false);

		wallClock.mockReturnValue(10_000_000 - 3_600_000);
		now += 31_000;
		mockFindFirst.mockResolvedValue({ id: 'source-1' });
		expect(await isPaymentSourceTypeInUse(V1)).toBe(true);
	});
});
