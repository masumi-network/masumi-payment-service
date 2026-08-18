/**
 * A flapping session must not hide a stuck close latch.
 *
 * The reaper aged candidates off `HydraHead.updatedAt`, which is `@updatedAt`:
 * the connection manager writes the row on every successful attach (it
 * increments the ownership fence), so a head reconnecting more often than the
 * ten-minute window never looked stale. Its latch stayed set, and a head that
 * is still Open — whose close never reached the chain — went on refusing every
 * new L2 reservation.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockGetHead = jest.fn() as AnyMock;
const mockFlushHeadStatus = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findMany: mockFindMany, updateMany: mockUpdateMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: mockGetHead, flushHeadStatus: mockFlushHeadStatus }),
}));

let releaseStalledCloseAdmissions: typeof import('./index').releaseStalledCloseAdmissions;

beforeAll(async () => {
	({ releaseStalledCloseAdmissions } = await import('./index'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindMany.mockResolvedValue([{ id: 'head-1' }]);
	mockGetHead.mockReturnValue({});
	mockFlushHeadStatus.mockResolvedValue(undefined);
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('releaseStalledCloseAdmissions', () => {
	it('ages candidates off when the latch was taken, not off the last write to the row', async () => {
		await releaseStalledCloseAdmissions();

		const where = mockFindMany.mock.calls[0]?.[0]?.where as Record<string, unknown>;
		expect(where).toHaveProperty('closingSince');
		expect(where).not.toHaveProperty('updatedAt');
	});

	it('clears the timestamp with the latch, so the next close starts its own clock', async () => {
		await expect(releaseStalledCloseAdmissions()).resolves.toBe(1);

		expect(mockUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { isClosing: false, closingSince: null } }),
		);
	});

	// No session means no authority to say anything about the head, and a Close
	// may still be in flight.
	it('leaves the latch alone when there is no session for the head', async () => {
		mockGetHead.mockReturnValue(null);

		await expect(releaseStalledCloseAdmissions()).resolves.toBe(0);
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});
});
