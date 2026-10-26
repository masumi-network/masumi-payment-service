import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ResolvedAddress } from '@masumi/payment-core/ssrf-guard';
import { createPublicClient } from 'viem';

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
	X402CounterpartyRole: {},
	X402EvmWalletType: {},
	prisma: {},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { error: jest.fn() },
}));

const mockResolveHostnameAddresses = jest.fn<(_hostname: string) => Promise<ResolvedAddress[]>>();
const mockIsBlockedIpAddress = jest.fn<(_address: string, _family: 4 | 6) => boolean>();
jest.unstable_mockModule('@masumi/payment-core/ssrf-guard', () => ({
	isPrivateIpLiteral: jest.fn(() => false),
	isPrivateOrUnresolvableHostname: jest.fn(async () => false),
	resolveHostnameAddresses: mockResolveHostnameAddresses,
	isBlockedIpAddress: mockIsBlockedIpAddress,
}));

const { createChain, safeHttpTransport } = await import('./internal');
const originalFetch = globalThis.fetch;
const servers: ReturnType<typeof createServer>[] = [];

async function requestChainId(rpcUrl: string) {
	const client = createPublicClient({
		chain: createChain('eip155:1', rpcUrl, 'Test'),
		transport: await safeHttpTransport(rpcUrl),
	});
	return client.getChainId();
}

afterEach(async () => {
	globalThis.fetch = originalFetch;
	mockResolveHostnameAddresses.mockReset();
	mockIsBlockedIpAddress.mockReset();
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('x402 RPC transport egress', () => {
	it('rejects a DNS answer that changes to loopback before a request', async () => {
		mockResolveHostnameAddresses.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		mockIsBlockedIpAddress.mockReturnValue(true);
		const fetchSpy = jest.fn<typeof fetch>().mockResolvedValue(
			new Response('{"jsonrpc":"2.0","id":1,"result":"0x1"}', {
				status: 200,
				headers: { 'Content-Type': 'application/json' },
			}),
		);
		globalThis.fetch = fetchSpy;

		await expect(requestChainId('http://rebind.invalid/rpc')).rejects.toThrow(/private|loopback/);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('uses a checked address without resolving the hostname again at the socket', async () => {
		let receivedHost: string | undefined;
		let receivedPath: string | undefined;
		const server = createServer((_request, response) => {
			receivedHost = _request.headers.host;
			receivedPath = _request.url;
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		mockResolveHostnameAddresses.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		mockIsBlockedIpAddress.mockReturnValue(false);

		await expect(requestChainId(`http://rebind.invalid:${port}/rpc?key=test`)).resolves.toBe(1);
		expect(receivedHost).toBe(`rebind.invalid:${port}`);
		expect(receivedPath).toBe('/rpc?key=test');
	});

	it('does not follow an RPC redirect', async () => {
		let secondRequests = 0;
		const server = createServer((request, response) => {
			if (request.url === '/second') {
				secondRequests += 1;
				response.writeHead(200, { 'Content-Type': 'application/json' });
				response.end('{"jsonrpc":"2.0","id":1,"result":"0x1"}');
				return;
			}
			response.writeHead(302, { Location: '/second' }).end();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		mockResolveHostnameAddresses.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		mockIsBlockedIpAddress.mockReturnValue(false);

		await expect(requestChainId(`http://127.0.0.1:${port}/first`)).rejects.toThrow(/redirect/i);
		expect(secondRequests).toBe(0);
	});

	it('decodes compressed RPC responses as the previous fetch transport did', async () => {
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
			response.end(gzipSync('{"jsonrpc":"2.0","id":1,"result":"0x1"}'));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		mockResolveHostnameAddresses.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		mockIsBlockedIpAddress.mockReturnValue(false);

		await expect(requestChainId(`http://127.0.0.1:${port}/rpc`)).resolves.toBe(1);
	});

	it('stops reading an oversized RPC response', async () => {
		const maxResponseBytes = 8 * 1024 * 1024;
		const server = createServer((_request, response) => {
			response.writeHead(200, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1', padding: 'x'.repeat(maxResponseBytes) }));
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		mockResolveHostnameAddresses.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		mockIsBlockedIpAddress.mockReturnValue(false);

		await expect(requestChainId(`http://127.0.0.1:${port}/rpc`)).rejects.toThrow(/too large/);
	});
});
