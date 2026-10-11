import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindUnique } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/services/hydra-host/own-node-control', () => ({
	setOwnHeadNodeRunning: jest.fn(),
}));

const { HYDRA_AUTO_RECOVERY_COOLDOWN_MS, recoverOrPauseAutoDisabledHead, resetAutoDisableRecoveryState } =
	await import('./head-auto-disable-recovery');

let clock = 0;
const reEnable = jest.fn<(hydraHeadId: string) => Promise<void>>();
const pause = jest.fn<(hydraHeadId: string, reason: string) => Promise<unknown>>();
const deps = { reEnable, pause, now: () => clock };

beforeEach(() => {
	jest.clearAllMocks();
	resetAutoDisableRecoveryState();
	clock = 1_000_000;
	reEnable.mockResolvedValue(undefined);
	pause.mockResolvedValue('requested');
	mockFindUnique.mockResolvedValue({ isEnabled: false });
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

	it('pauses instead of looping when the head fails closed again soon after', async () => {
		await recoverOrPauseAutoDisabledHead('head-1', deps);
		clock += HYDRA_AUTO_RECOVERY_COOLDOWN_MS - 1;

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('paused');
		expect(reEnable).toHaveBeenCalledTimes(1);
	});

	it('tries again once the cooldown has passed', async () => {
		await recoverOrPauseAutoDisabledHead('head-1', deps);
		clock += HYDRA_AUTO_RECOVERY_COOLDOWN_MS;

		await expect(recoverOrPauseAutoDisabledHead('head-1', deps)).resolves.toBe('re-enabled');
		expect(reEnable).toHaveBeenCalledTimes(2);
		expect(pause).not.toHaveBeenCalled();
	});
});
