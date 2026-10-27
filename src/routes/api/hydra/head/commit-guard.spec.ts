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
const mockFindHotWallet = jest.fn() as AnyMock;
const mockFindParticipant = jest.fn() as AnyMock;
const mockAssertReady = jest.fn() as AnyMock;
const mockBuildCommit = jest.fn() as AnyMock;
const mockReserveCommit = jest.fn() as AnyMock;
const mockGenerateWallet = jest.fn() as AnyMock;
const mockReleaseWallet = jest.fn() as AnyMock;
const mockGetHead = jest.fn() as AnyMock;
const mockFindTopup = jest.fn() as AnyMock;
const mockClaimWallet = jest.fn() as AnyMock;
const mockReconcileCommit = jest.fn() as AnyMock;

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
		hydraHead: { findUnique: mockFindHead, update: jest.fn(), updateMany: jest.fn() },
		hydraHeadError: { create: jest.fn() },
		hotWallet: { findUniqueOrThrow: mockFindHotWallet },
		hydraLocalParticipant: { findUnique: mockFindParticipant },
		hydraTopup: { findFirst: mockFindTopup },
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

jest.unstable_mockModule('./index', () => ({
	assertNodeReadyForDeposit: mockAssertReady,
	verifyPersistedHydraHeadOnChain: jest.fn(async () => ({ headIdentifier: 'a'.repeat(64) })),
}));
jest.unstable_mockModule('@/lib/hydra', () => ({
	buildValidatedHydraCommit: mockBuildCommit,
	HydraCommitFlowError: class HydraCommitFlowError extends Error {},
	HydraTransactionType: { TxConwayEra: 'TxConwayEra' },
	interpretCardanoTxSubmitResult: jest.fn(),
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getHead: mockGetHead }),
}));
jest.unstable_mockModule('@/services/hydra-commit-reconciliation', () => ({
	HydraCommitReservationConflictError: class HydraCommitReservationConflictError extends Error {},
	reconcilePendingHydraCommit: mockReconcileCommit,
	reserveAndSubmitHydraCommit: mockReserveCommit,
}));
jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({ generateWalletExtended: mockGenerateWallet }));
jest.unstable_mockModule('@/utils/converter/network-convert', () => ({
	convertNetwork: (network: unknown) => network,
}));
jest.unstable_mockModule('@/utils/hydra/l2-slot-context', () => ({
	resolveHydraL2EvidenceSlotConfig: () => ({ zeroTime: 0, zeroSlot: 0, slotLength: 1000 }),
}));
jest.unstable_mockModule('@/utils/db/hot-wallet-lock', () => ({
	claimHotWalletForL1: mockClaimWallet,
	releaseHotWalletAfterL1: mockReleaseWallet,
}));
jest.unstable_mockModule('@/services/hydra-head-error/record', () => ({ recordHeadError: jest.fn() }));

let commitHeadPost: { handler: (args: { input: unknown; options: unknown }) => Promise<unknown> };
let commitInput: { safeParse: (input: unknown) => { success: boolean } };

beforeAll(async () => {
	({ commitHeadPost, commitInput } = (await import('./commit')) as never);
});

beforeEach(() => {
	jest.clearAllMocks();
	mockFindTopup.mockResolvedValue(null);
	mockClaimWallet.mockResolvedValue('claim-token');
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

describe('commitHeadPost top-up guard', () => {
	// The reservation refuses this too, but only after the carve has paid an L1
	// fee and left the wallet held for the stale-lock window.
	it('refuses while a top-up is unabsorbed, before claiming the wallet or carving', async () => {
		mockFindHead.mockResolvedValue({ ...head(HydraHeadStatus.Open), isClosing: false });
		mockFindTopup.mockResolvedValueOnce({ id: 'topup-1', status: 'Confirmed', createdAt: new Date() });

		await expect(
			commitHeadPost.handler({ input: { headId: 'head-1', lovelace: '10000000' }, options: {} }),
		).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/not been absorbed/) });
		expect(mockClaimWallet).not.toHaveBeenCalled();
		expect(mockCarve).not.toHaveBeenCalled();
		// An earlier commit's own Pending row must not refuse its retry here, before
		// the route can reconcile that commit.
		for (const [query] of mockFindTopup.mock.calls) {
			expect(query).toMatchObject({ where: { isInitialCommit: false } });
		}
	});
});

describe('commitHeadPost earlier commit', () => {
	// A top-up may start once the earlier commit's row is absorbed, before the
	// scheduler marks the participant committed. The retry must still report it.
	it('reconciles a landed earlier commit instead of refusing for a top-up', async () => {
		const earlier = head(HydraHeadStatus.Open);
		mockFindHead.mockResolvedValue({
			...earlier,
			isClosing: false,
			LocalParticipant: {
				...earlier.LocalParticipant,
				commitTxHash: 'd'.repeat(64),
				commitInvalidHereafterSlot: 1_000n,
			},
		});
		mockFindTopup.mockResolvedValue({ id: 'topup-1', status: 'Confirmed', createdAt: new Date() });
		mockGetHead.mockReturnValue({ cardanoTransaction: jest.fn() });
		mockAssertReady.mockResolvedValue(undefined);
		mockFindHotWallet.mockResolvedValue({
			Secret: { encryptedMnemonic: 'encrypted' },
			PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
		});
		mockFindParticipant.mockResolvedValue(null);
		mockReconcileCommit.mockResolvedValue('confirmed');

		await expect(
			commitHeadPost.handler({ input: { headId: 'head-1', lovelace: '10000000' }, options: {} }),
		).resolves.toMatchObject({ committed: true, commitTxHash: 'd'.repeat(64) });
		expect(mockCarve).not.toHaveBeenCalled();
	});
});

describe('commit amount limit', () => {
	it.each([
		['the largest amount a BigInt column holds', '9223372036854775807', true],
		['one more than that', '9223372036854775808', false],
	])('reads %s', (_label, lovelace, accepted) => {
		expect(commitInput.safeParse({ headId: 'head-1', lovelace }).success).toBe(accepted);
	});
});

describe('commit readiness after the carve', () => {
	it('refuses the deposit when chain sync is lost while the carve confirms', async () => {
		const carved = {
			input: { txHash: 'b'.repeat(64), outputIndex: 0 },
			output: { address: 'addr_test1...', amount: [{ unit: 'lovelace', quantity: '10000000' }] },
		};
		const cardanoTransaction = jest.fn();
		const noLongerReady = Object.assign(new Error('chain observation is stale'), { status: 503 });
		mockFindHead.mockResolvedValue(head(HydraHeadStatus.Open));
		mockFindHotWallet.mockResolvedValue({
			Secret: { encryptedMnemonic: 'encrypted' },
			PaymentSource: { network: 'Preprod', PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
		});
		mockFindParticipant.mockResolvedValue(null);
		mockGetHead.mockReturnValue({ cardanoTransaction });
		mockAssertReady.mockResolvedValue(undefined);
		mockGenerateWallet.mockResolvedValue({
			wallet: { getUtxos: jest.fn(async () => [carved]) },
			utxos: [carved],
			vKey: 'vkey',
			blockchainProvider: {},
		});
		mockCarve.mockImplementation(
			async ({ onCarveSubmitted }: { onCarveSubmitted: (hash: string) => Promise<void> }) => {
				await onCarveSubmitted('b'.repeat(64));
				mockAssertReady.mockRejectedValue(noLongerReady);
				return carved;
			},
		);
		mockBuildCommit.mockResolvedValue({
			txId: 'c'.repeat(64),
			invalidHereafterSlot: 1_000n,
			signedCommitTx: 'signed-deposit',
		});

		await expect(
			commitHeadPost.handler({ input: { headId: 'head-1', lovelace: '10000000' }, options: {} }),
		).rejects.toBe(noLongerReady);

		expect(mockAssertReady).toHaveBeenCalledTimes(2);
		expect(mockBuildCommit).toHaveBeenCalled();
		expect(mockReserveCommit).not.toHaveBeenCalled();
		expect(cardanoTransaction).not.toHaveBeenCalled();
		// The signed carve may still be in flight, so the wallet lock remains.
		expect(mockReleaseWallet).not.toHaveBeenCalled();
	});
});
