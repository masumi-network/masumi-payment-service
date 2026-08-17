/**
 * Releasing a reservation destroys the only copy of its node's Cardano signing
 * key — the Host discloses it once, at provisioning — and by the time an invite
 * is revoked or expires the funding cycle has usually put 30 ADA behind that
 * key. So the money comes back first, and a node whose balance could not be
 * settled keeps its row.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockParticipantFindMany = jest.fn() as AnyMock;
const mockParticipantDeleteMany = jest.fn() as AnyMock;
const mockSecretDeleteMany = jest.fn() as AnyMock;
const mockInviteFindMany = jest.fn() as AnyMock;
const mockWithdrawNodeFunds = jest.fn() as AnyMock;

const tx = {
	hydraLocalParticipant: { findMany: mockParticipantFindMany, deleteMany: mockParticipantDeleteMany },
	hydraSecretKey: { deleteMany: mockSecretDeleteMany },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: { findMany: mockParticipantFindMany },
		hydraHeadInvite: { findMany: mockInviteFindMany },
		$transaction: (run: (client: typeof tx) => Promise<unknown>) => run(tx),
	},
}));

jest.unstable_mockModule('@/services/hydra-node-funding/withdraw', () => ({
	withdrawNodeFunds: mockWithdrawNodeFunds,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let releaseReservedParticipants: typeof import('./release-reservation').releaseReservedParticipants;
let releaseAbandonedReservations: typeof import('./release-reservation').releaseAbandonedReservations;

beforeAll(async () => {
	({ releaseReservedParticipants, releaseAbandonedReservations } = await import('./release-reservation'));
});

const RESERVATION = { hydraHostId: 'host-1', hostNodeId: 'node-1' };

function sweep(code: string) {
	return { address: 'addr', balanceLovelace: '0', txHash: null, reason: null, code };
}

beforeEach(() => {
	jest.clearAllMocks();
	mockParticipantFindMany.mockResolvedValue([{ id: 'participant-1', hydraSecretKeyId: 'key-1' }]);
	mockInviteFindMany.mockResolvedValue([]);
	mockWithdrawNodeFunds.mockResolvedValue(sweep('swept'));
});

describe('releaseReservedParticipants', () => {
	it('sweeps the node before deleting it, and deletes the key with it', async () => {
		const result = await releaseReservedParticipants(RESERVATION);

		expect(mockWithdrawNodeFunds).toHaveBeenCalledWith('participant-1');
		expect(mockParticipantDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['participant-1'] } } });
		expect(mockSecretDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['key-1'] } } });
		expect(result).toEqual({ released: 1, retained: 0 });
	});

	it('deletes a node with nothing worth moving', async () => {
		mockWithdrawNodeFunds.mockResolvedValue(sweep('dust'));
		expect(await releaseReservedParticipants(RESERVATION)).toEqual({ released: 1, retained: 0 });
	});

	// Nothing is behind a key that does not exist here, so keeping the row would
	// protect nothing.
	it('deletes a node whose key was never stored here', async () => {
		mockWithdrawNodeFunds.mockResolvedValue(sweep('no-key'));
		expect(await releaseReservedParticipants(RESERVATION)).toEqual({ released: 1, retained: 0 });
	});

	// The defect this exists for: the balance is unknown, not zero. Deleting the
	// key here is what stranded the ADA permanently.
	it('keeps a node whose balance could not be read', async () => {
		mockWithdrawNodeFunds.mockResolvedValue(sweep('chain-unreadable'));

		const result = await releaseReservedParticipants(RESERVATION);

		expect(mockParticipantDeleteMany).not.toHaveBeenCalled();
		expect(mockSecretDeleteMany).not.toHaveBeenCalled();
		expect(result).toEqual({ released: 0, retained: 1 });
	});

	// Called before the invite is moved out of its live statuses, the sweep
	// refuses — so the release must keep the participant rather than read the
	// refusal as "nothing to move".
	it('keeps a node the sweep refused because an invite still holds it', async () => {
		mockWithdrawNodeFunds.mockResolvedValue(sweep('invite-holds'));

		expect(await releaseReservedParticipants(RESERVATION)).toEqual({ released: 0, retained: 1 });
		expect(mockParticipantDeleteMany).not.toHaveBeenCalled();
	});

	it('keeps a node whose sweep threw', async () => {
		mockWithdrawNodeFunds.mockRejectedValue(new Error('blockfrost is down'));

		expect(await releaseReservedParticipants(RESERVATION)).toEqual({ released: 0, retained: 1 });
		expect(mockParticipantDeleteMany).not.toHaveBeenCalled();
	});

	it('releases only the nodes it could settle', async () => {
		mockParticipantFindMany.mockResolvedValue([
			{ id: 'participant-1', hydraSecretKeyId: 'key-1' },
			{ id: 'participant-2', hydraSecretKeyId: 'key-2' },
		]);
		mockWithdrawNodeFunds.mockImplementation((id: string) =>
			Promise.resolve(sweep(id === 'participant-1' ? 'swept' : 'chain-unreadable')),
		);

		const result = await releaseReservedParticipants(RESERVATION);

		expect(mockParticipantDeleteMany).toHaveBeenCalledWith({ where: { id: { in: ['participant-1'] } } });
		expect(result).toEqual({ released: 1, retained: 1 });
	});

	it('does nothing when the reservation has already been released', async () => {
		mockParticipantFindMany.mockResolvedValue([]);

		expect(await releaseReservedParticipants(RESERVATION)).toEqual({ released: 0, retained: 0 });
		expect(mockWithdrawNodeFunds).not.toHaveBeenCalled();
	});
});

describe('releaseAbandonedReservations', () => {
	it('retries a reservation nothing holds any more', async () => {
		mockParticipantFindMany.mockResolvedValueOnce([RESERVATION]);

		const result = await releaseAbandonedReservations();

		expect(mockWithdrawNodeFunds).toHaveBeenCalledWith('participant-1');
		expect(result).toEqual({ released: 1, retained: 0 });
	});

	// A live invite's node is not abandoned: it needs its fuel to post an Init
	// the moment someone redeems.
	it('leaves a reservation a live invite still holds', async () => {
		mockParticipantFindMany.mockResolvedValueOnce([RESERVATION]);
		mockInviteFindMany.mockResolvedValue([RESERVATION]);

		expect(await releaseAbandonedReservations()).toEqual({ released: 0, retained: 0 });
		expect(mockWithdrawNodeFunds).not.toHaveBeenCalled();
	});

	// Redemption creates the participant and binds it to a head in two steps, so
	// a young unbound participant is an ordinary intermediate state.
	it('only considers participants older than the orphan grace period', async () => {
		mockParticipantFindMany.mockResolvedValueOnce([]);

		await releaseAbandonedReservations();

		const where = mockParticipantFindMany.mock.calls[0][0].where as {
			createdAt: { lt: Date };
			hydraHeadId: null;
		};
		expect(where.hydraHeadId).toBeNull();
		expect(Date.now() - where.createdAt.lt.getTime()).toBeGreaterThanOrEqual(60 * 60 * 1000);
	});
});
