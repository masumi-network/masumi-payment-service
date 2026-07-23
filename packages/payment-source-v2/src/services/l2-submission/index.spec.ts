import { describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraTransactionRejectedError } from '@/lib/hydra/hydra/errors';
import { executeReservedL2Submission, lockOpenHydraHeadForL2Reservation } from '.';

const signedTx = 'signed-transaction-cbor';
const intendedTxHash = 'intended-tx-hash';

function makeCallbacks() {
	return {
		signedTx,
		resolveIntendedTxHash: () => intendedTxHash,
		resolveValidityUpperSlot: () => 123n,
		reserve: jest.fn(async (_hash: string, _invalidHereafterSlot: bigint) => ({ id: 'reservation-1' })),
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
		expect(callbacks.reserve).toHaveBeenCalledWith(intendedTxHash, 123n);
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
});

describe('lockOpenHydraHeadForL2Reservation', () => {
	it('permits only an enabled Open head while holding its database row lock', async () => {
		const queryRaw = jest.fn(async () => [
			{ status: HydraHeadStatus.Open, isEnabled: true, isClosing: false, initTxHash: 'a'.repeat(64) },
		]);

		await expect(
			lockOpenHydraHeadForL2Reservation({ $queryRaw: queryRaw } as never, 'head-1'),
		).resolves.toBeUndefined();
		expect(queryRaw).toHaveBeenCalledTimes(1);
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
