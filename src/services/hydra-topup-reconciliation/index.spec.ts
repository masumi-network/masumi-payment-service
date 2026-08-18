import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockLookupConfirmedChainTx = jest.fn() as AnyMock;
const mockBlocksLatest = jest.fn() as AnyMock;
const mockUpdate = jest.fn() as AnyMock;
const mockCreate = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockFindMany = jest.fn() as AnyMock;
const mockIsUniqueConstraintError = jest.fn() as AnyMock;
const mockRelease = jest.fn() as AnyMock;

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
		hydraTopup: {
			create: mockCreate,
			update: mockUpdate,
			updateMany: mockUpdateMany,
			findMany: mockFindMany,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	isUniqueConstraintError: mockIsUniqueConstraintError,
}));

jest.unstable_mockModule('@/utils/db/hot-wallet-lock', () => ({
	releaseHotWalletAfterL1: mockRelease,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let reconcilePendingHydraTopup: typeof import('./index').reconcilePendingHydraTopup;
let reserveAndSubmitHydraTopup: typeof import('./index').reserveAndSubmitHydraTopup;
let reconcilePendingHydraTopups: typeof import('./index').reconcilePendingHydraTopups;
let HydraTopupReservationConflictError: typeof import('./index').HydraTopupReservationConflictError;

beforeAll(async () => {
	({
		reconcilePendingHydraTopup,
		reserveAndSubmitHydraTopup,
		reconcilePendingHydraTopups,
		HydraTopupReservationConflictError,
	} = await import('./index'));
});

const DEPOSIT_TX_HASH = 'a'.repeat(64);
const INVALID_HEREAFTER_SLOT = 1_000n;

function candidate(overrides: Partial<Parameters<typeof reconcilePendingHydraTopup>[0]> = {}) {
	return {
		id: 'topup-1',
		status: 'Pending' as const,
		depositTxHash: DEPOSIT_TX_HASH,
		invalidHereafterSlot: INVALID_HEREAFTER_SLOT,
		network: 'Preprod' as const,
		rpcProviderApiKey: 'project-key',
		...overrides,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockCreate.mockResolvedValue({ id: 'topup-1' });
	mockUpdate.mockResolvedValue({ id: 'topup-1' });
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockFindMany.mockResolvedValue([]);
	mockLookupConfirmedChainTx.mockResolvedValue('confirmed-valid');
	mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT + 10_000n) });
	mockIsUniqueConstraintError.mockReturnValue(false);
});

describe('reserveAndSubmitHydraTopup', () => {
	const reservation = {
		topupId: 'topup-1',
		hydraHeadId: 'head-1',
		hydraLocalParticipantId: 'participant-1',
		depositTxHash: DEPOSIT_TX_HASH,
		invalidHereafterSlot: INVALID_HEREAFTER_SLOT,
		committedLovelace: 5_000_000n,
		committedAssets: {},
	};

	// The row is created when the operator asks, so the reservation promotes it
	// rather than inserting: that is what makes the work visible while the
	// pre-split confirms.
	it('promotes the prepared row then returns the topup id and submit result', async () => {
		const submit = jest.fn<() => Promise<string>>().mockResolvedValue('ok');
		await expect(reserveAndSubmitHydraTopup(reservation, submit)).resolves.toEqual({
			topupId: 'topup-1',
			submitResult: 'ok',
		});
		expect(mockUpdate).toHaveBeenCalledTimes(1);
	});

	it('retains the pending row when submission throws ambiguously', async () => {
		const submit = jest.fn<() => Promise<unknown>>().mockRejectedValue(new Error('connection reset'));
		await expect(reserveAndSubmitHydraTopup(reservation, submit)).rejects.toThrow('connection reset');
		expect(mockUpdate).toHaveBeenCalledTimes(1);
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	// The unique index on the deposit hash is what actually reserves the deposit,
	// and it now fires on the promotion rather than on an insert.
	it('maps a unique-index violation to a reservation conflict', async () => {
		mockUpdate.mockRejectedValue(new Error('unique'));
		mockIsUniqueConstraintError.mockReturnValue(true);
		await expect(reserveAndSubmitHydraTopup(reservation, jest.fn<() => Promise<unknown>>())).rejects.toBeInstanceOf(
			HydraTopupReservationConflictError,
		);
	});
});

describe('reconcilePendingHydraTopup', () => {
	it('confirms when the deposit is confirmed-valid on L1', async () => {
		await expect(reconcilePendingHydraTopup(candidate())).resolves.toBe('confirmed');
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: 'Pending' },
			data: { status: 'Confirmed' },
		});
	});

	it('short-circuits an already-confirmed row without an L1 lookup', async () => {
		await expect(reconcilePendingHydraTopup(candidate({ status: 'Confirmed' }))).resolves.toBe('confirmed');
		expect(mockLookupConfirmedChainTx).not.toHaveBeenCalled();
	});

	it('fails a confirmed-invalid deposit', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('confirmed-invalid');
		await expect(reconcilePendingHydraTopup(candidate())).resolves.toBe('failed');
		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'topup-1', status: 'Pending' },
			data: { status: 'Failed' },
		});
	});

	it('stays pending while the deposit is unconfirmed', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('pending');
		await expect(reconcilePendingHydraTopup(candidate())).resolves.toBe('pending');
	});

	it('stays pending when absent but still within the validity + grace window', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('not-found');
		mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT) });
		await expect(reconcilePendingHydraTopup(candidate())).resolves.toBe('pending');
	});

	it('fails an absent deposit once past the validity + grace window', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('not-found');
		mockBlocksLatest.mockResolvedValue({ slot: Number(INVALID_HEREAFTER_SLOT + 1_000n) });
		await expect(reconcilePendingHydraTopup(candidate())).resolves.toBe('failed');
	});

	it('reports a malformed deposit hash', async () => {
		await expect(reconcilePendingHydraTopup(candidate({ depositTxHash: 'not-a-hash' }))).resolves.toBe('malformed');
	});

	it('surfaces transient L1 errors without mutating', async () => {
		mockLookupConfirmedChainTx.mockResolvedValue('transient-error');
		await expect(reconcilePendingHydraTopup(candidate())).resolves.toBe('transient-error');
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});
});

/**
 * The commit handler writes a HydraTopup row alongside its own reservation so
 * the deposit shows up in the list. That row names the SAME L1 transaction as
 * `LocalParticipant.commitTxHash`, which the commit reconciler already releases
 * on — so both jobs released, on their own schedules, for one deposit.
 *
 * The second release is the dangerous one: `releaseHotWalletAfterL1` is fenced
 * on `lockPurpose`, a shared constant rather than an operation's identity, so
 * once this row has resolved and a later top-up has claimed the same wallet, the
 * stale releaser frees THAT operation's lock while its carve is unconfirmed.
 */
describe('reconcilePendingHydraTopups lock release attribution', () => {
	function row(commitTxHash: string | null) {
		return {
			id: 'topup-1',
			status: 'Pending',
			depositTxHash: DEPOSIT_TX_HASH,
			invalidHereafterSlot: INVALID_HEREAFTER_SLOT,
			LocalParticipant: {
				walletId: 'wallet-1',
				commitTxHash,
				Wallet: {
					PaymentSource: {
						network: 'Preprod',
						PaymentSourceConfig: { rpcProviderApiKey: 'key' },
					},
				},
			},
		};
	}

	beforeEach(() => {
		mockFindMany.mockResolvedValue([]);
		// Confirmed on chain, so the row resolves and the release is reached.
		mockLookupConfirmedChainTx.mockResolvedValue({ kind: 'confirmed', validContract: true, confirmations: 10 });
		mockUpdateMany.mockResolvedValue({ count: 1 });
	});

	it('releases the wallet for an ordinary top-up', async () => {
		mockFindMany.mockResolvedValue([row(null)]);

		await reconcilePendingHydraTopups();

		expect(mockRelease).toHaveBeenCalledWith('wallet-1');
	});

	it('leaves the release to the commit reconciler for the commit display row', async () => {
		mockFindMany.mockResolvedValue([row(DEPOSIT_TX_HASH)]);

		await reconcilePendingHydraTopups();

		expect(mockRelease).not.toHaveBeenCalled();
	});
});
