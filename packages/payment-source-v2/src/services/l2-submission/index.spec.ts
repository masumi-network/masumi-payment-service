import { describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraTransactionRejectedError, HydraTransportError } from '@/lib/hydra/hydra/errors';
import { executeReservedL2Submission, lockOpenHydraHeadForL2Reservation } from '.';

const signedTx = 'signed-transaction-cbor';
const intendedTxHash = 'intended-tx-hash';
const inputRef = `${'e'.repeat(64)}#0`;

function makeCallbacks() {
	return {
		signedTx,
		resolveIntendedTxHash: () => intendedTxHash,
		resolveValidityUpperSlot: () => 123n,
		resolveInputRefs: () => [inputRef],
		reserve: jest.fn(async (_hash: string, _invalidHereafterSlot: bigint, _inputRefs: string[]) => ({
			id: 'reservation-1',
		})),
		submit: jest.fn(async (_transaction: string) => intendedTxHash),
		finalize: jest.fn(async (_reservation: { id: string }, _txHash: string, _hash: string) => undefined),
		rollback: jest.fn(async (_reservation: { id: string }, _hash: string) => undefined),
	};
}

describe('executeReservedL2Submission', () => {
	it('durably reserves before submit and finalizes a matching accepted hash', async () => {
		const events: string[] = [];
		const callbacks = makeCallbacks();
		callbacks.reserve.mockImplementation(async () => {
			events.push('reserve');
			return { id: 'reservation-1' };
		});
		callbacks.submit.mockImplementation(async () => {
			events.push('submit');
			return intendedTxHash;
		});
		callbacks.finalize.mockImplementation(async () => {
			events.push('finalize');
		});

		await expect(executeReservedL2Submission(callbacks)).resolves.toEqual({
			status: 'accepted',
			intendedTxHash,
			txHash: intendedTxHash,
		});
		expect(events).toEqual(['reserve', 'submit', 'finalize']);
		// The inputs are what later proves an ambiguous body dead; see
		// decideL2ReservationRelease. Without them the wallet stays pinned forever.
		expect(callbacks.reserve).toHaveBeenCalledWith(intendedTxHash, 123n, [inputRef]);
		expect(callbacks.rollback).not.toHaveBeenCalled();
	});

	it('rolls back only an explicit hydra-node rejection', async () => {
		const callbacks = makeCallbacks();
		const rejection = new HydraTransactionRejectedError('invalid transaction');
		callbacks.submit.mockRejectedValue(rejection);

		await expect(executeReservedL2Submission(callbacks)).resolves.toEqual({
			status: 'definitively-rejected',
			intendedTxHash,
			error: rejection,
		});
		expect(callbacks.rollback).toHaveBeenCalledWith({ id: 'reservation-1' }, intendedTxHash);
		expect(callbacks.finalize).not.toHaveBeenCalled();
	});

	// The class is raised only before any byte is queued, so there is no
	// transaction anywhere to reconcile against — a retained reservation here
	// could never be resolved by anything, and it keeps the wallet leased and the
	// head's final handoff blocked behind it.
	it('rolls back a command that never reached the transport', async () => {
		const callbacks = makeCallbacks();
		const notSent = new HydraTransportError('Hydra provider is no longer admitted for transaction submission');
		callbacks.submit.mockRejectedValue(notSent);

		await expect(executeReservedL2Submission(callbacks)).resolves.toEqual({
			status: 'not-dispatched',
			intendedTxHash,
			error: notSent,
		});
		expect(callbacks.rollback).toHaveBeenCalledWith({ id: 'reservation-1' }, intendedTxHash);
		expect(callbacks.finalize).not.toHaveBeenCalled();
	});

	// A rollback that itself fails leaves the reservation in place: that is the
	// one outcome where the never-sent command stops being the whole story.
	it('retains the reservation when rolling back a never-sent command fails', async () => {
		const callbacks = makeCallbacks();
		const notSent = new HydraTransportError('transport closed before the command was sent');
		const rollbackError = new Error('database unavailable');
		callbacks.submit.mockRejectedValue(notSent);
		callbacks.rollback.mockRejectedValue(rollbackError);

		await expect(executeReservedL2Submission(callbacks)).resolves.toEqual({
			status: 'ambiguous',
			phase: 'rollback',
			intendedTxHash,
			error: rollbackError,
			rejectionError: notSent,
		});
	});

	it('retains the reservation when submission fails ambiguously', async () => {
		const callbacks = makeCallbacks();
		const transportError = new Error('socket closed');
		callbacks.submit.mockRejectedValue(transportError);

		await expect(executeReservedL2Submission(callbacks)).resolves.toEqual({
			status: 'ambiguous',
			phase: 'submit',
			intendedTxHash,
			error: transportError,
		});
		expect(callbacks.rollback).not.toHaveBeenCalled();
		expect(callbacks.finalize).not.toHaveBeenCalled();
	});

	it('retains the reservation when hydra returns a divergent hash', async () => {
		const callbacks = makeCallbacks();
		callbacks.submit.mockResolvedValue('different-hash');

		const outcome = await executeReservedL2Submission(callbacks);

		expect(outcome).toEqual({
			status: 'ambiguous',
			phase: 'hash-mismatch',
			intendedTxHash,
			error: expect.any(Error),
		});
		expect(callbacks.rollback).not.toHaveBeenCalled();
		expect(callbacks.finalize).not.toHaveBeenCalled();
	});

	it('retains an accepted reservation when final persistence fails', async () => {
		const callbacks = makeCallbacks();
		const databaseError = new Error('database unavailable');
		callbacks.finalize.mockRejectedValue(databaseError);

		await expect(executeReservedL2Submission(callbacks)).resolves.toEqual({
			status: 'accepted-db-pending',
			intendedTxHash,
			txHash: intendedTxHash,
			error: databaseError,
		});
		expect(callbacks.rollback).not.toHaveBeenCalled();
	});

	it('retains the reservation when explicit-rejection rollback fails', async () => {
		const callbacks = makeCallbacks();
		const rejection = new HydraTransactionRejectedError('invalid transaction');
		const rollbackError = new Error('database unavailable');
		callbacks.submit.mockRejectedValue(rejection);
		callbacks.rollback.mockRejectedValue(rollbackError);

		await expect(executeReservedL2Submission(callbacks)).resolves.toEqual({
			status: 'ambiguous',
			phase: 'rollback',
			intendedTxHash,
			error: rollbackError,
			rejectionError: rejection,
		});
		expect(callbacks.finalize).not.toHaveBeenCalled();
	});

	it('never submits when the durable reservation fails', async () => {
		const callbacks = makeCallbacks();
		const databaseError = new Error('database unavailable');
		callbacks.reserve.mockRejectedValue(databaseError);

		await expect(executeReservedL2Submission(callbacks)).rejects.toBe(databaseError);
		expect(callbacks.submit).not.toHaveBeenCalled();
		expect(callbacks.finalize).not.toHaveBeenCalled();
		expect(callbacks.rollback).not.toHaveBeenCalled();
	});

	it('never reserves or submits a body without a signed upper validity bound', async () => {
		const callbacks = makeCallbacks();
		callbacks.resolveValidityUpperSlot = () => {
			throw new Error('missing invalid_hereafter');
		};

		await expect(executeReservedL2Submission(callbacks)).rejects.toThrow('missing invalid_hereafter');
		expect(callbacks.reserve).not.toHaveBeenCalled();
		expect(callbacks.submit).not.toHaveBeenCalled();
	});

	it('never reserves or submits a body whose inputs cannot be read', async () => {
		const callbacks = makeCallbacks();
		callbacks.resolveInputRefs = () => {
			throw new Error('no inputs');
		};

		await expect(executeReservedL2Submission(callbacks)).rejects.toThrow('no inputs');
		expect(callbacks.reserve).not.toHaveBeenCalled();
		expect(callbacks.submit).not.toHaveBeenCalled();
	});
});

describe('lockOpenHydraHeadForL2Reservation', () => {
	it('permits only an enabled Open head while holding its database row lock', async () => {
		const queryRaw = jest.fn(async () => [
			{ status: HydraHeadStatus.Open, isEnabled: true, isClosing: false, initTxHash: 'a'.repeat(64) },
		]);

		await expect(
			lockOpenHydraHeadForL2Reservation({ $queryRaw: queryRaw } as never, 'head-1'),
		).resolves.toBeUndefined();
		// The head row, then the Host row under FOR SHARE for the pause check.
		expect(queryRaw).toHaveBeenCalledTimes(2);
	});

	// Deferred, not failed: the request waits for Resume instead of leaving L2.
	it('defers a reservation on a paused Host', async () => {
		const queryRaw = jest
			.fn<() => Promise<unknown[]>>()
			.mockResolvedValueOnce([
				{ status: HydraHeadStatus.Open, isEnabled: true, isClosing: false, initTxHash: 'a'.repeat(64) },
			])
			.mockResolvedValueOnce([{ pausedAt: new Date() }]);

		await expect(lockOpenHydraHeadForL2Reservation({ $queryRaw: queryRaw } as never, 'head-1')).rejects.toThrow(
			'is on a paused hydra host',
		);
	});

	it.each([
		['Final', { status: HydraHeadStatus.Final, isEnabled: true, isClosing: false, initTxHash: 'a'.repeat(64) }],
		['disabled', { status: HydraHeadStatus.Open, isEnabled: false, isClosing: false, initTxHash: 'a'.repeat(64) }],
		['closing', { status: HydraHeadStatus.Open, isEnabled: true, isClosing: true, initTxHash: 'a'.repeat(64) }],
		['unverified', { status: HydraHeadStatus.Open, isEnabled: true, isClosing: false, initTxHash: null }],
		['missing', null],
	] as const)('rejects a %s head before reserving', async (_description, head) => {
		const queryRaw = jest.fn(async () => (head == null ? [] : [head]));

		await expect(lockOpenHydraHeadForL2Reservation({ $queryRaw: queryRaw } as never, 'head-1')).rejects.toThrow(
			'Hydra head head-1 is no longer accepting L2 reservations',
		);
	});
});

describe('lockOpenHydraHeadForL2Reservation collateral drain', () => {
	const OPEN = { status: HydraHeadStatus.Open, isEnabled: true, isClosing: false, initTxHash: 'a'.repeat(64) };

	function client(collateralDrainedAt: Date | null, withdrawalsInFlight: number) {
		return {
			$queryRaw: jest.fn(async () => [{ ...OPEN, collateralDrainedAt }]),
			hydraDecommit: { count: jest.fn(async () => withdrawalsInFlight) },
			hydraHead: { update: jest.fn(async (_args: unknown) => ({})) },
		};
	}

	it('refuses a new escrow while the drain withdrawal is still in flight', async () => {
		const tx = client(new Date(), 1);

		await expect(
			lockOpenHydraHeadForL2Reservation(tx as never, 'head-1', { walletHoldsCollateral: true }),
		).rejects.toThrow('collateral was withdrawn');
		expect(tx.hydraHead.update).not.toHaveBeenCalled();
	});

	it('refuses a new escrow after the drain until collateral is back', async () => {
		const tx = client(new Date(), 0);

		await expect(
			lockOpenHydraHeadForL2Reservation(tx as never, 'head-1', { walletHoldsCollateral: false }),
		).rejects.toThrow('collateral was withdrawn');
		expect(tx.hydraHead.update).not.toHaveBeenCalled();
	});

	it('lifts the drain mark and admits once collateral is restored', async () => {
		const tx = client(new Date(), 0);

		await expect(
			lockOpenHydraHeadForL2Reservation(tx as never, 'head-1', { walletHoldsCollateral: true }),
		).resolves.toBeUndefined();
		expect(tx.hydraHead.update).toHaveBeenCalledWith({
			where: { id: 'head-1' },
			data: { collateralDrainedAt: null },
		});
	});

	// Settling an escrow that already exists is what the drained head still has
	// to allow; only admission of a new one is gated.
	it('does not gate actions on existing escrows', async () => {
		const tx = client(new Date(), 1);

		await expect(lockOpenHydraHeadForL2Reservation(tx as never, 'head-1')).resolves.toBeUndefined();
	});
});
