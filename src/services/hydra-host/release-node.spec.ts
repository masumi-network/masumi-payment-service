import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockRemoveHostNode = jest.fn() as AnyMock;
const mockLoggerWarn = jest.fn() as AnyMock;

jest.unstable_mockModule('@/services/hydra-host/client', () => ({
	removeHostNode: mockRemoveHostNode,
	HydraHostRequestError: class HydraHostRequestError extends Error {
		constructor(
			message: string,
			readonly status: number | null,
		) {
			super(message);
		}
	},
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: (value: string) => `decrypted-${value}`,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
}));

let releaseHostNodeOfFinishedHead: typeof import('./release-node').releaseHostNodeOfFinishedHead;
let HydraHostRequestError: typeof import('@/services/hydra-host/client').HydraHostRequestError;

beforeAll(async () => {
	({ releaseHostNodeOfFinishedHead } = await import('./release-node'));
	({ HydraHostRequestError } = await import('@/services/hydra-host/client'));
});

const HOST = { baseUrl: 'https://host.example', encryptedAdminToken: 'token', allowInsecureHttp: false };
const PARTICIPANT = { hostNodeId: 'node-1', HydraHost: HOST };

beforeEach(() => {
	jest.clearAllMocks();
	mockRemoveHostNode.mockResolvedValue(undefined);
});

describe('releaseHostNodeOfFinishedHead', () => {
	// The Host refuses a plain removal for a node that has had peers, because its
	// persistence directory may hold the only copy of the head state. A finished
	// head is the case it tells the caller to force.
	it('removes the node with force, using the decrypted admin token', async () => {
		await releaseHostNodeOfFinishedHead(PARTICIPANT);

		expect(mockRemoveHostNode).toHaveBeenCalledWith('https://host.example', 'decrypted-token', 'node-1', {
			force: true,
			allowInsecureHttp: false,
		});
	});

	it('passes the Host insecure-http setting on', async () => {
		await releaseHostNodeOfFinishedHead({ ...PARTICIPANT, HydraHost: { ...HOST, allowInsecureHttp: true } });

		expect(mockRemoveHostNode).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'node-1', {
			force: true,
			allowInsecureHttp: true,
		});
	});

	// A retry after a partly failed relation delete finds the first node gone.
	it('treats a node the Host no longer has as released', async () => {
		mockRemoveHostNode.mockRejectedValue(new HydraHostRequestError('no such node: node-1', 404));

		await expect(releaseHostNodeOfFinishedHead(PARTICIPANT)).resolves.toBeUndefined();
	});

	it.each([
		['the Host refuses', 409],
		['the Host fails', 500],
		['the Host cannot be reached', null],
	])('answers 502 naming the node when %s', async (_label, status) => {
		mockRemoveHostNode.mockRejectedValue(new HydraHostRequestError('node-side message', status));

		await expect(releaseHostNodeOfFinishedHead(PARTICIPANT)).rejects.toMatchObject({
			statusCode: 502,
			message: expect.stringContaining('node-1'),
		});
	});

	// Nothing can be sent to such a Host, and refusing to delete on that basis
	// would strand the participant's rows behind a node nobody can name.
	it('names the node to remove by hand when the Host has no admin token', async () => {
		await expect(
			releaseHostNodeOfFinishedHead({ ...PARTICIPANT, HydraHost: { ...HOST, encryptedAdminToken: null } }),
		).resolves.toBeUndefined();

		expect(mockRemoveHostNode).not.toHaveBeenCalled();
		expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('node-1'));
	});
});
