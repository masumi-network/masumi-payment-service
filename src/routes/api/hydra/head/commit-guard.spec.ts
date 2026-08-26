/**
 * Committing is refused before anything is spent.
 *
 * hydra-node accepts a commit while a head is Initializing, so this endpoint
 * used to as well — but that draft spends the vInitial output under a Plutus
 * redeemer and pays the head script rather than the deposit script, and
 * `validateHydraCommitDraft` refuses both. The request could never succeed, yet
 * it reached that point only AFTER `carveExactUtxo` had submitted a real L1
 * transaction, and the handler then deliberately holds the participant's hot
 * wallet for the whole stale-lock window because a carve is unsettled.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindHead = jest.fn() as AnyMock;
const mockCarve = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: { findUnique: mockFindHead, update: jest.fn(), updateMany: jest.fn() },
		hydraHeadError: { create: jest.fn() },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@/services/hydra-topup/pre-split', () => ({
	carveExactUtxo: mockCarve,
	HydraPreSplitError: class HydraPreSplitError extends Error {},
}));

let commitHeadPost: { handler: (args: { input: unknown; options: unknown }) => Promise<unknown> };

beforeAll(async () => {
	({ commitHeadPost } = (await import('./lifecycle')) as never);
});

beforeEach(() => {
	jest.clearAllMocks();
});

function head(status: HydraHeadStatus) {
	return {
		id: 'head-1',
		status,
		isEnabled: true,
		headIdentifier: 'a'.repeat(64),
		LocalParticipant: { id: 'participant-1', walletId: 'wallet-1', hasCommitted: false },
	};
}

describe('commitHeadPost status guard', () => {
	it('refuses an Initializing head before any L1 spend', async () => {
		mockFindHead.mockResolvedValue(head(HydraHeadStatus.Initializing));

		await expect(
			commitHeadPost.handler({ input: { headId: 'head-1', lovelace: '10000000' }, options: {} }),
		).rejects.toMatchObject({ status: 409 });
		// The carve is the L1 transaction. It must not have been reached.
		expect(mockCarve).not.toHaveBeenCalled();
	});

	it('names the deposit as the way in, rather than reporting a bare status mismatch', async () => {
		mockFindHead.mockResolvedValue(head(HydraHeadStatus.Initializing));

		await expect(
			commitHeadPost.handler({ input: { headId: 'head-1', lovelace: '10000000' }, options: {} }),
		).rejects.toThrow(/deposit/);
	});

	it('still refuses a closed head', async () => {
		mockFindHead.mockResolvedValue(head(HydraHeadStatus.Closed));

		await expect(
			commitHeadPost.handler({ input: { headId: 'head-1', lovelace: '10000000' }, options: {} }),
		).rejects.toMatchObject({ status: 409 });
		expect(mockCarve).not.toHaveBeenCalled();
	});
});
