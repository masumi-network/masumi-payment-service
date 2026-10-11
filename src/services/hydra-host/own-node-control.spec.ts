import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockStart = jest.fn<(..._args: unknown[]) => Promise<void>>();
const mockStop = jest.fn<(..._args: unknown[]) => Promise<void>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraLocalParticipant: { findUnique: mockFindUnique } },
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: (value: string) => `plain:${value}`,
}));
jest.unstable_mockModule('./client', () => ({
	startHostNode: mockStart,
	stopHostNode: mockStop,
}));

const { setOwnHeadNodeRunning } = await import('./own-node-control');

function participant(encryptedAdminToken: string | null, head = { status: 'Open', isClosing: false }) {
	return {
		hostNodeId: 'node-1',
		HydraHost: { baseUrl: 'https://hydra.example.com', encryptedAdminToken, allowInsecureHttp: false },
		HydraHead: head,
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockStart.mockResolvedValue(undefined);
	mockStop.mockResolvedValue(undefined);
});

describe('setOwnHeadNodeRunning', () => {
	it('stops the head node with the decrypted admin token', async () => {
		mockFindUnique.mockResolvedValue(participant('enc-admin'));

		await expect(setOwnHeadNodeRunning('head-1', false, 'test')).resolves.toBe('requested');
		expect(mockStop).toHaveBeenCalledWith('https://hydra.example.com', 'plain:enc-admin', 'node-1', {
			allowInsecureHttp: false,
		});
		expect(mockStart).not.toHaveBeenCalled();
	});

	it('starts the head node when asked to run it', async () => {
		mockFindUnique.mockResolvedValue(participant('enc-admin'));

		await expect(setOwnHeadNodeRunning('head-1', true, 'test')).resolves.toBe('requested');
		expect(mockStart).toHaveBeenCalledTimes(1);
		expect(mockStop).not.toHaveBeenCalled();
	});

	it('reports a host registered without an admin token instead of calling it', async () => {
		mockFindUnique.mockResolvedValue(participant(null));

		await expect(setOwnHeadNodeRunning('head-1', false, 'test')).resolves.toBe('no-admin-token');
		expect(mockStop).not.toHaveBeenCalled();
	});

	it('reports a head without a local participant', async () => {
		mockFindUnique.mockResolvedValue(null);

		await expect(setOwnHeadNodeRunning('head-1', false, 'test')).resolves.toBe('no-participant');
	});

	// The caller runs this beside a durable enable-state write that must stand
	// even when the Host is unreachable.
	it('never throws when the Host call fails', async () => {
		mockFindUnique.mockResolvedValue(participant('enc-admin'));
		mockStop.mockRejectedValue(new Error('host unreachable'));

		await expect(setOwnHeadNodeRunning('head-1', false, 'test')).resolves.toBe('failed');
	});

	// A stopped node cannot contest a stale close, and the contestation period
	// does not wait for it.
	it.each([
		{ status: 'Closed', isClosing: true },
		{ status: 'FanoutPossible', isClosing: true },
		{ status: 'Open', isClosing: true },
	])('never stops the node of a closing head (%o)', async (head) => {
		mockFindUnique.mockResolvedValue(participant('enc-admin', head));

		await expect(setOwnHeadNodeRunning('head-1', false, 'test')).resolves.toBe('head-closing');
		expect(mockStop).not.toHaveBeenCalled();
	});

	it('still starts the node of a closing head', async () => {
		mockFindUnique.mockResolvedValue(participant('enc-admin', { status: 'Closed', isClosing: true }));

		await expect(setOwnHeadNodeRunning('head-1', true, 'test')).resolves.toBe('requested');
		expect(mockStart).toHaveBeenCalledTimes(1);
	});
});
