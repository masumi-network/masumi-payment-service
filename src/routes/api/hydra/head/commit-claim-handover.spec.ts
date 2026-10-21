/**
 * A refused commit retry hands its wallet claim to the commit still pending.
 *
 * The retry claims the wallet, finds an earlier commit unresolved and refuses.
 * It keeps the lock, because that commit's inputs still read as unspent. But
 * the earlier commit's reconciler releases with the earlier claim's token, so
 * unless the retry's token is written onto that reservation, the wallet waits
 * out the full stale-lock window.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const EARLIER_COMMIT_TX_HASH = 'b'.repeat(64);
const RETRY_TOKEN = 'retry-token';

const mockFindParticipant = jest.fn() as AnyMock;
const mockUpdateParticipant = jest.fn() as AnyMock;
const mockReconcile = jest.fn() as AnyMock;
const mockRelease = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	assertHydraHeadHostNotPaused: jest.fn(async () => undefined),
	isHydraHeadOnPausedHost: jest.fn(async () => false),
	isHydraHeadOnPausedHostLocked: jest.fn(async () => false),
	HYDRA_HOST_PAUSED_MESSAGE: 'hydra host is paused for maintenance',
}));

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraHead: {
			findUnique: jest.fn(async () => ({
				id: 'head-1',
				status: HydraHeadStatus.Open,
				isEnabled: true,
				headIdentifier: 'a'.repeat(64),
				LocalParticipant: {
					id: 'participant-1',
					walletId: 'wallet-1',
					hasCommitted: false,
					commitTxHash: EARLIER_COMMIT_TX_HASH,
					commitInvalidHereafterSlot: 100n,
				},
			})),
		},
		hotWallet: {
			findUniqueOrThrow: jest.fn(async () => ({
				PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
			})),
		},
		hydraLocalParticipant: { findUnique: mockFindParticipant, updateMany: mockUpdateParticipant },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({
	recordHeadError: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: () => ({}) }),
}));

jest.unstable_mockModule('./index', () => ({
	assertNodeReadyForDeposit: jest.fn(async () => undefined),
	verifyPersistedHydraHeadOnChain: jest.fn(async () => ({})),
	getErrorMessage: (error: unknown) => String(error),
}));

jest.unstable_mockModule('@/utils/db/hot-wallet-lock', () => ({
	claimHotWalletForL1: jest.fn(async () => RETRY_TOKEN),
	releaseHotWalletAfterL1: mockRelease,
}));

jest.unstable_mockModule('@/services/hydra-commit-reconciliation', () => ({
	HydraCommitReservationConflictError: class HydraCommitReservationConflictError extends Error {},
	reconcilePendingHydraCommit: mockReconcile,
	reserveAndSubmitHydraCommit: jest.fn(),
}));

let commitHeadPost: { handler: (args: { input: unknown; options: unknown }) => Promise<unknown> };

beforeAll(async () => {
	({ commitHeadPost } = (await import('./lifecycle')) as never);
});

beforeEach(() => {
	jest.clearAllMocks();
	// The earlier commit is still unresolved on L1, so the retry is refused.
	mockReconcile.mockResolvedValue('pending');
	mockFindParticipant.mockResolvedValue({
		commitTxHash: EARLIER_COMMIT_TX_HASH,
		hasCommitted: false,
		commitWalletClaimToken: 'earlier-token',
	});
	mockUpdateParticipant.mockResolvedValue({ count: 1 });
});

async function retryCommit(): Promise<void> {
	await expect(
		commitHeadPost.handler({ input: { headId: 'head-1', lovelace: '10000000' }, options: {} }),
	).rejects.toMatchObject({ status: 409 });
}

describe('commitHeadPost refused retry', () => {
	it('hands its claim to the pending commit so that commit frees the wallet', async () => {
		await retryCommit();

		expect(mockUpdateParticipant).toHaveBeenCalledWith({
			where: {
				id: 'participant-1',
				hasCommitted: false,
				commitTxHash: EARLIER_COMMIT_TX_HASH,
				commitWalletClaimToken: 'earlier-token',
			},
			data: { commitWalletClaimToken: RETRY_TOKEN },
		});
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('releases the wallet itself when the pending commit settled in the meantime', async () => {
		mockUpdateParticipant.mockResolvedValue({ count: 0 });

		await retryCommit();

		expect(mockRelease).toHaveBeenCalledWith('wallet-1', RETRY_TOKEN);
	});
});
