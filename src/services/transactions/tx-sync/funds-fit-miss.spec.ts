import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

const mockUpdateMany = jest.fn() as Mock<(...args: unknown[]) => Promise<{ count: number }>>;
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { purchaseActionData: { updateMany: mockUpdateMany } },
}));

let pickClosestFundsFitMiss: typeof import('./funds-fit-miss').pickClosestFundsFitMiss;
let recordFundsFitMiss: typeof import('./funds-fit-miss').recordFundsFitMiss;
let buildFundsFitMissNote: typeof import('./timeout-note').buildFundsFitMissNote;

beforeAll(async () => {
	({ pickClosestFundsFitMiss, recordFundsFitMiss } = await import('./funds-fit-miss'));
	({ buildFundsFitMissNote } = await import('./timeout-note'));
});

beforeEach(() => {
	mockUpdateMany.mockReset();
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

const usdm = 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d';
const miss = (walletId: string, purchaseRequestId: string, availableAmount: string) => ({
	walletId,
	purchaseRequestId,
	unit: usdm,
	requiredAmount: '2000000',
	availableAmount,
});

describe('pickClosestFundsFitMiss', () => {
	it('returns the miss with the most of the unit for that request only', () => {
		const misses = [miss('w1', 'pr-1', '400000'), miss('w2', 'pr-2', '9000000000'), miss('w3', 'pr-1', '1500000')];
		expect(pickClosestFundsFitMiss(misses, 'pr-1')).toMatchObject({ walletId: 'w3' });
		expect(pickClosestFundsFitMiss(misses, 'pr-9')).toBeNull();
	});

	it('reports the deepest shortage when wallets fell short on different units', () => {
		// w1 holds 2.5 of 3 ADA (83%); w2 holds 0.4 of 2 USDM (20%). The raw
		// lovelace figure is larger, the USDM shortage is the one to report.
		const ada = {
			walletId: 'w1',
			purchaseRequestId: 'pr-1',
			unit: '',
			requiredAmount: '3000000',
			availableAmount: '2500000',
		};
		expect(pickClosestFundsFitMiss([ada, miss('w2', 'pr-1', '400000')], 'pr-1')).toMatchObject({ walletId: 'w2' });
	});
});

describe('recordFundsFitMiss', () => {
	const params = {
		nextActionId: 'action-1',
		miss: miss('w1', 'pr-1', '400000'),
		freeWalletCount: 1,
		eligibleWalletCount: 3,
	};

	it('writes the note only onto a still-pending lock action without an error', async () => {
		await recordFundsFitMiss({ ...params, currentErrorNote: null });
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'action-1', requestedAction: 'FundsLockingRequested', errorType: null },
			data: {
				errorNote: buildFundsFitMissNote({
					unit: usdm,
					requiredAmount: '2000000',
					availableAmount: '400000',
					freeWalletCount: 1,
					eligibleWalletCount: 3,
				}),
			},
		});
	});

	it('skips the write when the action already carries this note', async () => {
		const note = buildFundsFitMissNote({
			unit: usdm,
			requiredAmount: '2000000',
			availableAmount: '400000',
			freeWalletCount: 1,
			eligibleWalletCount: 3,
		});
		await recordFundsFitMiss({ ...params, currentErrorNote: note });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});
});
