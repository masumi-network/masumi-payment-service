/**
 * A withdrawal is refused to the operator's face, not to a log file.
 *
 * The endpoint answers before the work runs, and the executor raises six
 * refusals ahead of the block that records anything. This handler mirrored four
 * of them: a head with no local participant, and a node still replaying its
 * chain history, both answered `accepted: true`. The UI then toasted
 * "Withdrawal started. It appears below" and pointed at a list that stayed
 * empty forever — no `HydraDecommit` row, no head error, one log line.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockGetHead = jest.fn() as AnyMock;
const mockAssertReady = jest.fn() as AnyMock;
const mockExecute = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindHead }, hydraDecommit: { findMany: jest.fn() } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: mockGetHead }),
}));

jest.unstable_mockModule('@/routes/api/hydra/head', () => ({
	assertNodeReadyForDeposit: mockAssertReady,
}));

jest.unstable_mockModule('@/services/hydra-decommit/execute', () => ({ executeHydraDecommit: mockExecute }));

let withdrawHeadPost: { handler: (args: { input: unknown }) => Promise<unknown> };

beforeAll(async () => {
	({ withdrawHeadPost } = (await import('./withdraw')) as never);
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindHead.mockResolvedValue({
		isEnabled: true,
		status: HydraHeadStatus.Open,
		headIdentifier: 'a'.repeat(64),
		LocalParticipant: { id: 'participant-1' },
	});
	mockGetHead.mockReturnValue({});
	mockAssertReady.mockResolvedValue(undefined);
	mockExecute.mockResolvedValue({ decommitId: 'decommit-1' });
});

const input = { headId: 'head-1', lovelace: '10000000', drain: false };

describe('withdrawHeadPost pre-flight', () => {
	it('accepts once the head, the session and the node all answer', async () => {
		await expect(withdrawHeadPost.handler({ input })).resolves.toMatchObject({ accepted: true });
		expect(mockExecute).toHaveBeenCalled();
	});

	// The node is up but behind. A withdrawal has no L1 deadline to miss, but it
	// needs the head to sign a snapshot and a node still catching up will not —
	// so the request only ever becomes a reservation nobody resolves.
	it('refuses while the node is still catching up', async () => {
		mockAssertReady.mockRejectedValue(Object.assign(new Error('still catching up'), { statusCode: 409 }));

		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({ message: 'still catching up' });
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('refuses a head with no node on this side', async () => {
		mockFindHead.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Open,
			headIdentifier: 'a'.repeat(64),
			LocalParticipant: null,
		});

		await expect(withdrawHeadPost.handler({ input })).rejects.toMatchObject({ statusCode: 400 });
		expect(mockAssertReady).not.toHaveBeenCalled();
		expect(mockExecute).not.toHaveBeenCalled();
	});
});
