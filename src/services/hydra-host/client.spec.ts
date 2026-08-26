import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { fetchHostCapabilities } from './client';

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

describe('Hydra Host transport security', () => {
	it('does not send a bearer token to a stored remote plaintext URL', async () => {
		const fetchMock = jest.fn<() => Promise<Response>>();
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			fetchHostCapabilities('http://10.0.0.8:4000', 'admin-token', { allowInsecureHttp: false }),
		).rejects.toThrow(/explicit allowInsecureHttp/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends to HTTP only after the persisted opt-in is supplied', async () => {
		const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue(
			new Response(
				JSON.stringify({
					hydraVersion: '0.20.0',
					network: 'Preprod',
					nodeSlots: { used: 0, capacity: 2 },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			fetchHostCapabilities('http://10.0.0.8:4000', 'admin-token', { allowInsecureHttp: true }),
		).resolves.toMatchObject({ hydraVersion: '0.20.0' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});
