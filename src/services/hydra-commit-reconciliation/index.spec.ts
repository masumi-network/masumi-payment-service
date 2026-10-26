import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { Prisma } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockLookupConfirmedChainTx = jest.fn() as AnyMock;
const mockBlocksLatest = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockFindMany = jest.fn() as AnyMock;
const mockCreateRecovery = jest.fn() as AnyMock;
const mockTransaction = jest.fn() as AnyMock;
const transactionClient = {
	$queryRaw: (...args: any[]) => mockQueryRaw(...args),
	hydraLocalParticipant: { findMany: mockFindMany, updateMany: mockUpdateMany },
	hydraTopup: { create: mockCreateRecovery },
};

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: mockLookupConfirmedChainTx,
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ blocksLatest: mockBlocksLatest }),
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 5 },
}));

const mockQueryRaw = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async <T>(operation: () => Promise<T>) => await operation(),
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { ...transactionClient, $transaction: mockTransaction },
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
		commitWalletClaimToken: 'claim-token-1',
		network: 'Preprod',
		rpcProviderApiKey: 'project-key',
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(
		async (run: (tx: typeof transactionClient) => Promise<unknown>) => await run(transactionClient),
	);
	mockCreateRecovery.mockResolvedValue({ id: 'recovery-1' });
	mockQueryRaw.mockResolvedValue([{ status: 'Open', isEnabled: true, isClosing: false }]);
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockFindMany.mockResolvedValue([]);
	mockLookupConfirmedChainTx.mockResolvedValue('confirmed-valid');
	mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT + 10_000n) });
});

type ReservedCommit = {
	commitTxHash: string;
	commitInvalidHereafterSlot: bigint;
	commitWalletClaimToken: string;
};
type RecoveryRecord = Prisma.HydraTopupUncheckedCreateInput;

/** Only the DB boundary is modeled: failed create/commit cannot persist drafts. */
function modelCommitTransaction(failure?: 'create' | 'commit') {
	const committed: { reservation: ReservedCommit | null; deposit: RecoveryRecord | null } = {
		reservation: null,
		deposit: null,
	};
	mockTransaction.mockImplementation(async (run: (tx: typeof transactionClient) => Promise<unknown>) => {
		const draft = structuredClone(committed);
		mockUpdateMany.mockImplementation(async ({ data }: { data: ReservedCommit }) => {
			draft.reservation = data;
			return { count: 1 };
		});
		mockCreateRecovery.mockImplementation(async ({ data }: { data: RecoveryRecord }) => {
			if (failure === 'create') throw new Error('create failed');
			draft.deposit = data;
			return { id: 'recovery-1' };
		});
		const result = await run(transactionClient);
		if (failure === 'commit') throw new Error('commit failed');
		Object.assign(committed, draft);
		return result;
	});
	return committed;
}

describe('reserveAndSubmitHydraCommit', () => {
	const reservation = {
		participantId: 'participant-1',
		hydraHeadId: 'head-1',
		commitTxHash: COMMIT_TX_HASH,
		invalidHereafterSlot: INVALID_HEREAFTER_SLOT,
		walletClaimToken: 'claim-token-1',
		committedLovelace: 9_007_199_254_740_993n,
		committedAssets: { ['ab'.repeat(28) + '01']: '9007199254740993' },
	};

	it('retains the reservation when submission throws ambiguously', async () => {
		const submit = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('connection reset'));

		await expect(reserveAndSubmitHydraCommit(reservation, submit)).rejects.toThrow('connection reset');
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'participant-1',
				hydraHeadId: 'head-1',
				hasCommitted: false,
				commitTxHash: null,
				commitInvalidHereafterSlot: null,
			},
			data: {
				commitTxHash: COMMIT_TX_HASH,
				commitInvalidHereafterSlot: INVALID_HEREAFTER_SLOT,
				commitWalletClaimToken: 'claim-token-1',
			},
		});
	});

	it('retains the reservation when the node returns an explicit rejection', async () => {
		const rejection = { tag: 'FailedToPostTx', failureReason: 'rejected' };
		const submit = jest.fn<() => Promise<unknown>>().mockResolvedValue(rejection);

		await expect(reserveAndSubmitHydraCommit(reservation, submit)).resolves.toBe(rejection);
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
	});

	// A close admitted while the commit was carved must stop it before L1: a
	// deposit that lands after close is not in the fanout.
	it('does not reserve or submit once the head is closing', async () => {
		mockQueryRaw.mockResolvedValue([{ status: 'Open', isEnabled: true, isClosing: true }]);
		const submit = jest.fn<() => Promise<unknown>>();

		await expect(reserveAndSubmitHydraCommit(reservation, submit)).rejects.toMatchObject({ status: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
	});

	it('does not submit when another exact reservation won the race', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });
		const submit = jest.fn<() => Promise<unknown>>();

		await expect(reserveAndSubmitHydraCommit(reservation, submit)).rejects.toBeInstanceOf(
			HydraCommitReservationConflictError,
		);
		expect(submit).not.toHaveBeenCalled();
		expect(mockCreateRecovery).not.toHaveBeenCalled();
	});

	it('persists the exact recovery record and claim before an ambiguous submission', async () => {
		const committed = modelCommitTransaction();
		const submit = jest.fn(async () => {
			expect(committed.reservation?.commitTxHash).toBe(COMMIT_TX_HASH);
			expect(committed.deposit).toMatchObject({
				hydraHeadId: 'head-1',
				hydraLocalParticipantId: 'participant-1',
				depositTxHash: COMMIT_TX_HASH,
				invalidHereafterSlot: INVALID_HEREAFTER_SLOT,
				committedLovelace: reservation.committedLovelace,
				committedAssets: reservation.committedAssets,
				walletClaimToken: 'claim-token-1',
				isInitialCommit: true,
				status: 'Pending',
			});
			throw new Error('connection reset after broadcast');
		});
		await expect(reserveAndSubmitHydraCommit(reservation, submit)).rejects.toThrow('connection reset after broadcast');
		expect(committed.deposit?.depositTxHash).toBe(COMMIT_TX_HASH);
	});

	it.each(['create', 'commit'] as const)(
		'does not submit or retain half a reservation when %s fails',
		async (failure) => {
			const committed = modelCommitTransaction(failure);
			const submit = jest.fn(async () => 'submitted');
			await expect(reserveAndSubmitHydraCommit(reservation, submit)).rejects.toThrow(`${failure} failed`);
			expect(submit).not.toHaveBeenCalled();
			expect(committed).toEqual({ reservation: null, deposit: null });
		},
	);

	it('refuses a competing pending deposit before submission', async () => {
		mockCreateRecovery.mockRejectedValue(Object.assign(new Error('pending deposit exists'), { code: 'P2002' }));
		const submit = jest.fn(async () => 'submitted');
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
				commitWalletClaimToken: 'claim-token-1',
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
				commitWalletClaimToken: 'claim-token-1',
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
				commitWalletClaimToken: 'claim-token-1',
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
