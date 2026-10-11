import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-paused-node-watchdog', () => ({
	convergeDisabledHeadNode: jest.fn(),
}));

const {
	HYDRA_AUTO_RECOVERY_COOLDOWN_MS,
	continueAfterStatusPersistenceRecovery,
	forgetHeadFailedClosed,
	markHeadFailedClosed,
	recoverOrPauseAutoDisabledHead,
	resetAutoDisableRecoveryState,
} = await import('./head-auto-disable-recovery');

let clock = 0;
const reEnable = jest.fn<(hydraHeadId: string) => Promise<void>>();
const pause = jest.fn<(hydraHeadId: string, reason: string) => Promise<boolean>>();
const deps = { reEnable, pause, now: () => clock };

beforeEach(() => {
	jest.clearAllMocks();
	resetAutoDisableRecoveryState();
	clock = 1_000_000;
	reEnable.mockResolvedValue(undefined);
	pause.mockResolvedValue(true);
	mockFindUnique.mockResolvedValue({ isEnabled: false });
	markHeadFailedClosed('head-1');
});

describe('recoverOrPauseAutoDisabledHead', () => {
	it('does nothing when the head is still enabled', async () => {
		mockFindUnique.mockResolvedValue({ isEnabled: true });

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('still-enabled');
		expect(reEnable).not.toHaveBeenCalled();
		expect(pause).not.toHaveBeenCalled();
	});

	it('re-enables a failed-closed head once and keeps its node running', async () => {
		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('re-enabled');
		expect(reEnable).toHaveBeenCalledWith('head-1');
		expect(pause).not.toHaveBeenCalled();
	});

	// Otherwise the counterparty's node keeps getting co-signatures and keeps
	// locking funds in a head this side does not observe.
	it('pauses the node when the re-enable fails', async () => {
		reEnable.mockRejectedValue(new Error('L1 verification failed'));

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('paused');
		expect(pause).toHaveBeenCalledWith('head-1', expect.any(String));
	});

	// The operator must not be told the node is stopped when it is not.
	it('reports a pause that did not stop the node', async () => {
		reEnable.mockRejectedValue(new Error('L1 verification failed'));
		pause.mockResolvedValue(false);

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('pause-failed');
	});

	it('pauses instead of looping when the head fails closed again soon after', async () => {
		await recoverOrPauseAutoDisabledHead('head-1', deps);
		clock += HYDRA_AUTO_RECOVERY_COOLDOWN_MS - 1;
		markHeadFailedClosed('head-1');

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('paused');
		expect(reEnable).toHaveBeenCalledTimes(1);
	});

	it('tries again once the cooldown has passed', async () => {
		await recoverOrPauseAutoDisabledHead('head-1', deps);
		clock += HYDRA_AUTO_RECOVERY_COOLDOWN_MS;
		markHeadFailedClosed('head-1');

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('re-enabled');
		expect(reEnable).toHaveBeenCalledTimes(2);
		expect(pause).not.toHaveBeenCalled();
	});

	// An operator disable, or a rollback quarantined for explicit recovery, is
	// not this process's failure to undo.
	it('leaves a head alone that this process did not fail closed', async () => {
		forgetHeadFailedClosed('head-1');

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('not-failed-closed');
		expect(reEnable).not.toHaveBeenCalled();
		expect(pause).not.toHaveBeenCalled();
	});

	it('acts once per failure when two recoveries race', async () => {
		const results = await Promise.all([
			recoverOrPauseAutoDisabledHead('head-1', deps),
			recoverOrPauseAutoDisabledHead('head-1', deps),
		]);

		expect(results.sort()).toEqual(['not-failed-closed', 're-enabled']);
		expect(reEnable).toHaveBeenCalledTimes(1);
	});

	// An operator re-enable can finish first; the auto attempt then loses its
	// compare-and-set. Stopping the node of the now enabled head would strand it.
	it('does not pause a head that came back while the re-enable failed', async () => {
		mockFindUnique.mockResolvedValueOnce({ isEnabled: false }).mockResolvedValueOnce({ isEnabled: true });
		reEnable.mockRejectedValue(Object.assign(new Error('changed during verification'), { statusCode: 409 }));

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('still-enabled');
		expect(pause).not.toHaveBeenCalled();
	});
});

describe('continueAfterStatusPersistenceRecovery', () => {
	it('does nothing when the head reconnected', async () => {
		await expect(continueAfterStatusPersistenceRecovery('head-1', true, deps)).resolves.toBeNull();
		expect(reEnable).not.toHaveBeenCalled();
	});

	it('recovers a head that stayed disabled', async () => {
		await expect(continueAfterStatusPersistenceRecovery('head-1', false, deps)).resolves.toBe('re-enabled');
	});

	it('hands the head to the operator when the re-read itself failed', async () => {
		await expect(continueAfterStatusPersistenceRecovery('head-1', null, deps)).resolves.toBeNull();
		// The mark is gone: a later recovery does not re-enable it either.
		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('not-failed-closed');
		expect(reEnable).not.toHaveBeenCalled();
	});
});
