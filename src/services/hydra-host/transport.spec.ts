import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';

const dnsLookup = jest.fn<(...args: any[]) => Promise<Array<{ address: string; family: number }>>>();
jest.unstable_mockModule('node:dns/promises', () => ({ lookup: dnsLookup }));

let fetchHostCapabilities: typeof import('./client').fetchHostCapabilities;
let fetchHydraHost: typeof import('./transport').fetchHydraHost;
let resolveAllowedHostDestination: typeof import('./destination').resolveAllowedHostDestination;
let server: Server;
let port: number;
let requests = 0;
let handleRequest: RequestListener;
const initialTrustedHosts = process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
const HOSTNAME = 'pinned.invalid';
const TOKEN = 'admin-token';
const transport = { allowInsecureHttp: true };
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const localAddress = { address: '127.0.0.1', family: 4 };

function hostUrl() {
	return `http://${HOSTNAME}:${port}`;
}

beforeAll(async () => {
	({ fetchHostCapabilities } = await import('./client'));
	({ fetchHydraHost } = await import('./transport'));
	({ resolveAllowedHostDestination } = await import('./destination'));
	server = createServer((request, response) => {
		requests += 1;
		handleRequest(request, response);
	});
	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', resolve);
	});
	port = (server.address() as AddressInfo).port;
});

beforeEach(() => {
	requests = 0;
	dnsLookup.mockReset();
	dnsLookup.mockResolvedValue([localAddress]);
	process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = HOSTNAME;
	handleRequest = (_request, response) => {
		response.end(JSON.stringify({ hydraVersion: '2.4.1', network: 'Preprod' }));
	};
});

afterEach(() => {
	if (initialTrustedHosts === undefined) delete process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
	else process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = initialTrustedHosts;
});

afterAll(async () => {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('stored Hydra Host destinations', () => {
	it('refuses a stored private URL before making its control-plane request', async () => {
		delete process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;

		await expect(fetchHostCapabilities(`http://127.0.0.1:${port}`, TOKEN, transport)).rejects.toThrow(
			/private|loopback|link-local/,
		);
		expect(requests).toBe(0);
	});

	it('rechecks a stored hostname whose DNS changed after registration', async () => {
		delete process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
		dnsLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]).mockResolvedValueOnce([localAddress]);
		await expect(resolveAllowedHostDestination(hostUrl())).resolves.toEqual([{ address: '8.8.8.8', family: 4 }]);

		await expect(fetchHostCapabilities(hostUrl(), TOKEN, transport)).rejects.toThrow(/private|loopback|link-local/);
		expect(requests).toBe(0);
	});

	it('pins the checked answers instead of resolving again when connecting', async () => {
		dnsLookup.mockResolvedValueOnce([localAddress]).mockRejectedValueOnce(new Error('second DNS lookup refused'));

		await expect(fetchHostCapabilities(hostUrl(), TOKEN, transport)).resolves.toMatchObject({ hydraVersion: '2.4.1' });
		expect(dnsLookup).toHaveBeenCalledTimes(1);
		expect(requests).toBe(1);
	});

	it('tries another checked address when the first cannot connect', async () => {
		dnsLookup.mockResolvedValue([{ address: '127.0.0.2', family: 4 }, localAddress]);

		await expect(fetchHostCapabilities(hostUrl(), TOKEN, transport)).resolves.toMatchObject({ hydraVersion: '2.4.1' });
		expect(dnsLookup).toHaveBeenCalledTimes(1);
		expect(requests).toBe(1);
	});
});

describe('pinned Host HTTP transport', () => {
	it('preserves the hostname, path, method, credential, idempotency key and JSON body', async () => {
		let observedBody = '';
		let observedHeaders: object | undefined;
		let observedMethod: string | undefined;
		let observedPath: string | undefined;
		handleRequest = (request, response) => {
			observedHeaders = request.headers;
			observedMethod = request.method;
			observedPath = request.url;
			request.on('data', (chunk: Buffer) => {
				observedBody += chunk.toString('utf8');
			});
			request.on('end', () => {
				response.writeHead(201);
				response.end('{}');
			});
		};
		const body = JSON.stringify({ peers: ['peer.example:5001'] });
		const response = await fetchHydraHost(`${hostUrl()}/v1/nodes/node-1?force=true`, {
			method: 'PATCH',
			headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' },
			body,
			signal: new AbortController().signal,
		});
		await response.text();

		expect(response.status).toBe(201);
		expect(observedHeaders).toMatchObject({
			host: `${HOSTNAME}:${port}`,
			authorization: `Bearer ${TOKEN}`,
			'idempotency-key': 'idem-1',
		});
		expect(observedMethod).toBe('PATCH');
		expect(observedPath).toBe('/v1/nodes/node-1?force=true');
		expect(observedBody).toBe(body);
	});

	it('does not follow a redirect to an unchecked private destination', async () => {
		handleRequest = (request, response) => {
			if (request.url === '/private') {
				response.end('secret');
				return;
			}
			response.writeHead(302, { Location: `http://127.0.0.1:${port}/private` });
			response.end();
		};

		await expect(fetchHostCapabilities(hostUrl(), TOKEN, transport)).rejects.toThrow('redirects are not allowed');
		expect(requests).toBe(1);
	});

	it('returns a manual redirect without contacting its target', async () => {
		handleRequest = (_request, response) => {
			response.writeHead(302, { Location: `http://127.0.0.1:${port}/private` });
			response.end('redirect');
		};

		const response = await fetchHydraHost(hostUrl(), {
			headers: {},
			signal: new AbortController().signal,
			redirect: 'manual',
		});

		expect(response.status).toBe(302);
		expect(await response.text()).toBe('redirect');
		expect(requests).toBe(1);
	});

	it('does not replay a mutation when the connection closes after the request', async () => {
		dnsLookup.mockResolvedValue([localAddress, localAddress]);
		handleRequest = (request, response) => {
			request.resume();
			request.on('end', () => response.socket?.destroy());
		};

		await expect(
			fetchHydraHost(hostUrl(), {
				method: 'POST',
				headers: {},
				body: '{}',
				signal: new AbortController().signal,
			}),
		).rejects.toThrow();
		expect(requests).toBe(1);
	});

	it('keeps the decoded response size bound for compressed replies', async () => {
		const compressed = gzipSync(' '.repeat(MAX_RESPONSE_BYTES + 1));
		handleRequest = (_request, response) => {
			response.writeHead(200, { 'Content-Encoding': 'gzip', 'Content-Length': compressed.byteLength });
			response.end(compressed);
		};

		await expect(fetchHostCapabilities(hostUrl(), TOKEN, transport)).rejects.toThrow('exceeded its byte limit');
	});

	it('accepts a compressed JSON reply from an existing proxy', async () => {
		handleRequest = (_request, response) => {
			response.writeHead(200, { 'Content-Encoding': 'gzip' });
			response.end(gzipSync(JSON.stringify({ hydraVersion: '2.4.1' })));
		};

		await expect(fetchHostCapabilities(hostUrl(), TOKEN, transport)).resolves.toMatchObject({ hydraVersion: '2.4.1' });
	});

	it('aborts a pending DNS lookup without opening a request', async () => {
		dnsLookup.mockImplementation(() => new Promise(() => undefined));
		const controller = new AbortController();
		const response = fetchHydraHost(hostUrl(), { headers: {}, signal: controller.signal });
		controller.abort();

		await expect(response).rejects.toThrow(/abort/i);
		expect(requests).toBe(0);
	});

	it('keeps the abort signal active while consuming the response body', async () => {
		handleRequest = (_request, response) => {
			response.writeHead(200);
			response.write('{');
		};
		const controller = new AbortController();
		const response = await fetchHydraHost(hostUrl(), { headers: {}, signal: controller.signal });
		const body = response.text();
		controller.abort();

		await expect(body).rejects.toThrow();
	});
});
