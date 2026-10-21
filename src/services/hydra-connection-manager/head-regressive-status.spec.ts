import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockQueryRaw = jest.fn() as AnyMock;
const mockHeadUpdateMany = jest.fn() as AnyMock;
const tx = {
	$queryRaw: mockQueryRaw,
	hydraHead: { updateMany: mockHeadUpdateMany },
	paymentRequest: { updateMany: jest.fn() },
	purchaseRequest: { updateMany: jest.fn() },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => await operation(tx) },
}));
jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

const { persistRegressiveHeadStatus } = await import('./head-session-ops');

const HEAD_ID = 'a'.repeat(56);
const finalHead = {
	id: 'head-1',
	hydraRelationId: 'relation-1',
	isEnabled: true,
	status: HydraHeadStatus.Final,
	headIdentifier: HEAD_ID,
	fanoutTxHash: null,
	ownerEpoch: 1n,
	retiredAt: null,
};
const retiredSibling = {
	...finalHead,
	id: 'head-0',
	isEnabled: false,
	status: HydraHeadStatus.FanoutPossible,
	headIdentifier: 'b'.repeat(56),
	retiredAt: new Date('2026-10-01T00:00:00Z'),
};

beforeEach(() => {
	jest.clearAllMocks();
	mockHeadUpdateMany.mockResolvedValue({ count: 1 });
});

describe('persistRegressiveHeadStatus beside a retired head', () => {
	// A retired head is outside the one-live-head index, so the rolled-back
	// head can be non-Final next to it without quarantining the relation.
	it('persists the rollback and leaves the retired head untouched', async () => {
		mockQueryRaw.mockResolvedValueOnce([{ id: 'relation-1' }]).mockResolvedValueOnce([retiredSibling, finalHead]);

		await expect(
			persistRegressiveHeadStatus('head-1', 'relation-1', HydraHeadStatus.FanoutPossible, HEAD_ID, undefined, 1n),
		).resolves.toBe('persisted');

		expect(mockHeadUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockHeadUpdateMany.mock.calls[0]![0]).toMatchObject({ where: { id: 'head-1' } });
	});

	// A session can take the epoch just after retire commits. Its rollback
	// frame must not move the retired head back or clear its init anchors.
	it('leaves a retired head alone even for the current owner', async () => {
		const retiredHead = { ...finalHead, status: HydraHeadStatus.FanoutPossible, retiredAt: new Date() };
		mockQueryRaw.mockResolvedValueOnce([{ id: 'relation-1' }]).mockResolvedValueOnce([retiredHead]);

		await expect(
			persistRegressiveHeadStatus('head-1', 'relation-1', HydraHeadStatus.Idle, HEAD_ID, undefined, 1n),
		).resolves.toBe('ignored');
		expect(mockHeadUpdateMany).not.toHaveBeenCalled();
	});

	it('still quarantines the relation for a live replacement head', async () => {
		const liveSibling = { ...retiredSibling, retiredAt: null };
		mockQueryRaw.mockResolvedValueOnce([{ id: 'relation-1' }]).mockResolvedValueOnce([liveSibling, finalHead]);

		await expect(
			persistRegressiveHeadStatus('head-1', 'relation-1', HydraHeadStatus.FanoutPossible, HEAD_ID, undefined, 1n),
		).resolves.toBe('quarantined-relation-conflict');

		// The sibling sweep spares retired heads: they keep their init anchors.
		expect(mockHeadUpdateMany.mock.calls[1]![0]).toMatchObject({
			where: { hydraRelationId: 'relation-1', id: { not: 'head-1' }, retiredAt: null },
		});
	});
});
