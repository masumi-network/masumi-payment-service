import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockLookupConfirmedChainTx = jest.fn() as AnyMock;
const mockBlocksLatest = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockFindMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: mockLookupConfirmedChainTx,
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ blocksLatest: mockBlocksLatest }),
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 5 },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: {
			findMany: mockFindMany,
			updateMany: mockUpdateMany,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let reconcilePendingHydraCommit: typeof import('./index').reconcilePendingHydraCommit;
let HYDRA_COMMIT_SLOT_GRACE: typeof import('./index').HYDRA_COMMIT_SLOT_GRACE;
let reserveAndSubmitHydraCommit: typeof import('./index').reserveAndSubmitHydraCommit;
let HydraCommitReservationConflictError: typeof import('./index').HydraCommitReservationConflictError;

beforeAll(async () => {
	({
		reconcilePendingHydraCommit,
		HYDRA_COMMIT_SLOT_GRACE,
		reserveAndSubmitHydraCommit,
		HydraCommitReservationConflictError,
	} = await import('./index'));
});

const COMMIT_TX_HASH = 'a'.repeat(64);
const INVALID_HEREAFTER_SLOT = 1_000n;

function candidate(
	overrides: Partial<Parameters<typeof reconcilePendingHydraCommit>[0]> = {},
): Parameters<typeof reconcilePendingHydraCommit>[0] {
	return {
		id: 'participant-1',
		hasCommitted: false,
		commitTxHash: COMMIT_TX_HASH,
		commitInvalidHereafterSlot: INVALID_HEREAFTER_SLOT,
		network: 'Preprod',
		rpcProviderApiKey: 'project-key',
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockFindMany.mockResolvedValue([]);
	mockLookupConfirmedChainTx.mockResolvedValue('confirmed-valid');
	mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT + 10_000n) });
});

describe('reserveAndSubmitHydraCommit', () => {
	const reservation = {
		participantId: 'participant-1',
		commitTxHash: COMMIT_TX_HASH,
		invalidHereafterSlot: INVALID_HEREAFTER_SLOT,
	};

	it('retains the reservation when submission throws ambiguously', async () => {
		const submit = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('connection reset'));

		await expect(reserveAndSubmitHydraCommit(reservation, submit)).rejects.toThrow('connection reset');
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'participant-1',
				hasCommitted: false,
				commitTxHash: null,
				commitInvalidHereafterSlot: null,
			},
			data: {
				commitTxHash: COMMIT_TX_HASH,
				commitInvalidHereafterSlot: INVALID_HEREAFTER_SLOT,
			},
		});
	});

	it('retains the reservation when the node returns an explicit rejection', async () => {
		const rejection = { tag: 'FailedToPostTx', failureReason: 'rejected' };
		const submit = jest.fn<() => Promise<unknown>>().mockResolvedValue(rejection);

		await expect(reserveAndSubmitHydraCommit(reservation, submit)).resolves.toBe(rejection);
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
	});

	it('does not submit when another exact reservation won the race', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });
		const submit = jest.fn<() => Promise<unknown>>();

		await expect(reserveAndSubmitHydraCommit(reservation, submit)).rejects.toBeInstanceOf(
			HydraCommitReservationConflictError,
		);
		expect(submit).not.toHaveBeenCalled();
	});
});

describe('reconcilePendingHydraCommit', () => {
	it('promotes only the exact pending hash and TTL after independent L1 inclusion', async () => {
		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('confirmed');
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'participant-1',
				hasCommitted: false,
				commitTxHash: COMMIT_TX_HASH,
				commitInvalidHereafterSlot: INVALID_HEREAFTER_SLOT,
			},
			data: { hasCommitted: true },
		});
		expect(mockLookupConfirmedChainTx).toHaveBeenCalledWith({
			network: 'Preprod',
			rpcProviderApiKey: 'project-key',
			txHash: COMMIT_TX_HASH,
			requiredConfirmations: 5,
		});
		expect(mockBlocksLatest).not.toHaveBeenCalled();
	});

	it('keeps a shallow commit reserved until it reaches the required depth', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('pending');

		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('pending');
		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockBlocksLatest).not.toHaveBeenCalled();
	});

	it('fails closed when independent inclusion evidence is unavailable', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('transient-error');
		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('transient-error');
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('clears a confirmed phase-2-invalid body without promoting it', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('confirmed-invalid');

		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('cleared');
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'participant-1',
				hasCommitted: false,
				commitTxHash: COMMIT_TX_HASH,
				commitInvalidHereafterSlot: INVALID_HEREAFTER_SLOT,
			},
			data: { commitTxHash: null, commitInvalidHereafterSlot: null },
		});
	});

	it('keeps an absent commit reserved through the exact TTL plus grace boundary', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('not-found');
		mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT + HYDRA_COMMIT_SLOT_GRACE) });

		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('pending');
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('clears an exact reservation only when L1 says absent beyond TTL plus grace', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('not-found');
		mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT + HYDRA_COMMIT_SLOT_GRACE + 1n) });

		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('cleared');
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'participant-1',
				hasCommitted: false,
				commitTxHash: COMMIT_TX_HASH,
				commitInvalidHereafterSlot: INVALID_HEREAFTER_SLOT,
			},
			data: { commitTxHash: null, commitInvalidHereafterSlot: null },
		});
	});

	it('never clears on a transient hash lookup or untrusted current slot', async () => {
		mockLookupConfirmedChainTx.mockResolvedValueOnce('transient-error');
		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('transient-error');

		mockLookupConfirmedChainTx.mockResolvedValueOnce('not-found');
		mockBlocksLatest.mockResolvedValueOnce({ slot: null });
		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('transient-error');
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('fails closed on partial or malformed pending evidence', async () => {
		await expect(reconcilePendingHydraCommit(candidate({ commitInvalidHereafterSlot: null }))).resolves.toBe(
			'malformed',
		);
		await expect(reconcilePendingHydraCommit(candidate({ commitTxHash: 'not-a-hash' }))).resolves.toBe('malformed');
		expect(mockLookupConfirmedChainTx).not.toHaveBeenCalled();
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('reports a guarded update race instead of overwriting concurrent state', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		await expect(reconcilePendingHydraCommit(candidate())).resolves.toBe('raced');
	});
});
