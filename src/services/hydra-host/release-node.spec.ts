import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockLoggerWarn = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: (value: string) => `decrypted-${value}`,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockLoggerWarn, error: jest.fn(), debug: jest.fn() },
}));

let releaseHostNodeOfFinishedHead: typeof import('./release-node').releaseHostNodeOfFinishedHead;

beforeAll(async () => {
	({ releaseHostNodeOfFinishedHead } = await import('./release-node'));
});

const HOST = { baseUrl: 'https://hydra.example.com', encryptedAdminToken: 'token', allowInsecureHttp: false };
const PARTICIPANT = { hostNodeId: 'node-1', HydraHost: HOST };

const fetchMock = jest.fn<typeof import('./transport').fetchHydraHost>();
jest.unstable_mockModule('./transport', () => ({ fetchHydraHost: fetchMock }));

function respond(status: number, body: Record<string, string> | null = null) {
	fetchMock.mockResolvedValue(new Response(body === null ? null : JSON.stringify(body), { status }));
}

beforeEach(() => {
	jest.clearAllMocks();
	fetchMock.mockReset();
	respond(202, { state: 'Removing' });
});

describe('releaseHostNodeOfFinishedHead', () => {
	// The Host refuses a plain removal for a node that has had peers, because its
	// persistence directory may hold the only copy of the head state. A finished
	// head is the case it tells the caller to force.
	it('removes the node with force, using the decrypted admin token', async () => {
		await releaseHostNodeOfFinishedHead(PARTICIPANT);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(url).toBe('https://hydra.example.com/v1/nodes/node-1?force=true');
		expect(init.method).toBe('DELETE');
		expect(init.headers).toMatchObject({ Authorization: 'Bearer decrypted-token' });
	});

	// A retry after a partly failed relation delete finds the first node gone.
	it('treats a node the Host no longer has as released', async () => {
		respond(404, { error: 'no such node: node-1' });

		await expect(releaseHostNodeOfFinishedHead(PARTICIPANT)).resolves.toBeUndefined();
	});

	// A base URL missing a proxy prefix answers 404 for the route itself. Taking
	// that as released would delete the only record that names the node.
	it('does not treat a 404 for an unknown route as released', async () => {
		respond(404, { error: 'not found' });

		await expect(releaseHostNodeOfFinishedHead(PARTICIPANT)).rejects.toMatchObject({ statusCode: 502 });
	});

	it.each([
		['the Host refuses', 409],
		['the Host fails', 500],
	])('answers an exposed 502 naming the node when %s', async (_label, status) => {
		respond(status, { error: 'node-side message' });

		await expect(releaseHostNodeOfFinishedHead(PARTICIPANT)).rejects.toMatchObject({
			statusCode: 502,
			expose: true,
			message: expect.stringContaining('node-1'),
		});
		expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('node-1'));
	});

	// Clearing the token stops provisioning on the Host, so it is offered only
	// when the Host did not answer at all.
	it('offers the admin-token way out only when the Host cannot be reached', async () => {
		fetchMock.mockRejectedValue(new TypeError('fetch failed'));
		await expect(releaseHostNodeOfFinishedHead(PARTICIPANT)).rejects.toMatchObject({
			statusCode: 502,
			message: expect.stringContaining('clear its admin token'),
		});

		respond(409, { error: 'node is busy' });
		await expect(releaseHostNodeOfFinishedHead(PARTICIPANT)).rejects.toMatchObject({
			message: expect.not.stringContaining('admin token'),
		});
	});

	// Nothing can be sent to such a Host, and refusing to delete on that basis
	// would strand the participant's rows behind a node nobody can name.
	it('names the node to remove by hand when the Host has no admin token', async () => {
		await expect(
			releaseHostNodeOfFinishedHead({ ...PARTICIPANT, HydraHost: { ...HOST, encryptedAdminToken: null } }),
		).resolves.toBeUndefined();

		expect(fetchMock).not.toHaveBeenCalled();
		expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('node-1'));
	});
});
