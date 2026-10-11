import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
	HYDRA_AUTO_RECOVERY_COOLDOWN_MS,
	continueAfterStatusPersistenceRecovery,
	forgetHeadFailedClosed,
	markHeadFailedClosed,
	recoverAutoDisabledHead,
	resetAutoDisableRecoveryState,
} = await import('./head-auto-disable-recovery');

let clock = 0;
const reEnable = jest.fn<(hydraHeadId: string) => Promise<void>>();
const deps = { reEnable, now: () => clock };

beforeEach(() => {
	jest.clearAllMocks();
	resetAutoDisableRecoveryState();
	clock = 1_000_000;
	reEnable.mockResolvedValue(undefined);
	mockFindUnique.mockResolvedValue({ isEnabled: false });
	markHeadFailedClosed('head-1');
});

describe('recoverAutoDisabledHead', () => {
	it('does nothing when the head is still enabled', async () => {
		mockFindUnique.mockResolvedValue({ isEnabled: true });

		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('still-enabled');
		expect(reEnable).not.toHaveBeenCalled();
	});

	it('re-enables a failed-closed head once', async () => {
		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('re-enabled');
		expect(reEnable).toHaveBeenCalledWith('head-1');
	});

	it('leaves the head disabled when the re-enable fails', async () => {
		reEnable.mockRejectedValue(new Error('L1 verification failed'));

		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('failed');
	});

	it('does not loop when the head fails closed again soon after', async () => {
		await recoverAutoDisabledHead('head-1', deps);
		clock += HYDRA_AUTO_RECOVERY_COOLDOWN_MS - 1;
		markHeadFailedClosed('head-1');

		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('cooldown');
		expect(reEnable).toHaveBeenCalledTimes(1);
	});

	it('tries again once the cooldown has passed', async () => {
		await recoverAutoDisabledHead('head-1', deps);
		clock += HYDRA_AUTO_RECOVERY_COOLDOWN_MS;
		markHeadFailedClosed('head-1');

		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('re-enabled');
		expect(reEnable).toHaveBeenCalledTimes(2);
	});

	// An operator disable, or a rollback quarantined for explicit recovery, is
	// not this process's failure to undo.
	it('leaves a head alone that this process did not fail closed', async () => {
		forgetHeadFailedClosed('head-1');

		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('not-failed-closed');
		expect(reEnable).not.toHaveBeenCalled();
	});

	// The operator's disable lands while recovery reads the head; it drops the
	// mark, and recovery must not then re-enable the head.
	it('does not re-enable a head the operator disabled during recovery', async () => {
		mockFindUnique.mockImplementation(async () => {
			forgetHeadFailedClosed('head-1');
			return { isEnabled: false };
		});

		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('not-failed-closed');
		expect(reEnable).not.toHaveBeenCalled();
	});

	it('leaves a head disabled that fails closed again during its re-enable', async () => {
		let inner: Promise<unknown> | undefined;
		reEnable.mockImplementation(async () => {
			markHeadFailedClosed('head-1');
			inner = recoverAutoDisabledHead('head-1', deps);
		});

		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('re-enabled');
		await expect(inner).resolves.toBe('cooldown');
		expect(reEnable).toHaveBeenCalledTimes(1);
		// The second failure's mark is gone, not left for a later recovery.
		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('not-failed-closed');
	});

	it('acts once per failure when two recoveries race', async () => {
		const results = await Promise.all([recoverAutoDisabledHead('head-1', deps), recoverAutoDisabledHead('head-1', deps)]);

		expect(results.sort()).toEqual(['not-failed-closed', 're-enabled']);
		expect(reEnable).toHaveBeenCalledTimes(1);
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
		await expect(recoverAutoDisabledHead('head-1', deps)).resolves.toBe('not-failed-closed');
		expect(reEnable).not.toHaveBeenCalled();
	});
});
