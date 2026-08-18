/**
 * A top-up is refused to the operator's face, not to a log file.
 *
 * The endpoint answers before the work runs, which is right — a deposit outlives
 * its request. But the executor raises five refusals ahead of the block that
 * records anything, and none of them created a row either: a top-up refused
 * because the node was still catching up, or because a batcher held the wallet,
 * returned `accepted: true`, toasted "Deposit started", and left the operator
 * polling for a deposit that would never exist. The same reasoning is already
 * written out in the withdraw endpoint, which checks synchronously.
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
	prisma: { hydraHead: { findUnique: mockFindHead }, hydraTopup: { findFirst: jest.fn() } },
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

jest.unstable_mockModule('@/services/hydra-topup/execute', () => ({ executeHydraTopup: mockExecute }));
jest.unstable_mockModule('@/services/hydra-topup/recover', () => ({ recoverHydraDeposit: jest.fn() }));

let topupHeadPost: { handler: (args: { input: unknown }) => Promise<unknown> };

beforeAll(async () => {
	({ topupHeadPost } = (await import('./topup')) as never);
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
	mockExecute.mockResolvedValue({ topupId: 'topup-1' });
});

const input = { headId: 'head-1', assetFilter: 'all', exactAmount: '50000000' };

describe('topupHeadPost pre-flight', () => {
	it('accepts once the head, the session and the node all answer', async () => {
		await expect(topupHeadPost.handler({ input })).resolves.toMatchObject({ accepted: true });
		expect(mockExecute).toHaveBeenCalled();
	});

	// The node is up but behind: the deposit would land on L1 at once and sit
	// unabsorbable until the node catches up, with its deadline running.
	it('refuses rather than reporting a deposit that was never started', async () => {
		mockAssertReady.mockRejectedValue(Object.assign(new Error('still catching up'), { statusCode: 409 }));

		await expect(topupHeadPost.handler({ input })).rejects.toMatchObject({ message: 'still catching up' });
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('refuses when there is no session for the head', async () => {
		mockGetHead.mockReturnValue(null);

		await expect(topupHeadPost.handler({ input })).rejects.toMatchObject({ statusCode: 502 });
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('refuses before the head identifier has been observed', async () => {
		mockFindHead.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Open,
			headIdentifier: null,
			LocalParticipant: { id: 'participant-1' },
		});

		await expect(topupHeadPost.handler({ input })).rejects.toMatchObject({ statusCode: 409 });
		expect(mockExecute).not.toHaveBeenCalled();
	});
	// The ledger refuses an output holding less than the minimum its size costs, so
	// the carve cannot be built at all. Answering "Top-up started" and failing in a
	// log a minute later is how a mistyped amount became invisible.
	it('refuses an exact lovelace amount below the carve floor', async () => {
		await expect(topupHeadPost.handler({ input: { headId: 'head-1', exactAmount: '900000' } })).rejects.toMatchObject({
			status: 400,
		});
		expect(mockExecute).not.toHaveBeenCalled();
	});

	it('still accepts an exact token amount below that number', async () => {
		await expect(
			topupHeadPost.handler({
				input: { headId: 'head-1', assetUnit: 'ab'.repeat(28) + '0014df10', exactAmount: '25' },
			}),
		).resolves.toMatchObject({ accepted: true });
	});
});
