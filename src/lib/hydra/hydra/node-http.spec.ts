import { afterEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HydraHttpClient } from './node-http';
import { CustomHydraHead } from './custom-head';

const previousTrustedHosts = process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
const servers: Server[] = [];

afterEach(async () => {
	if (previousTrustedHosts === undefined) delete process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
	else process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = previousTrustedHosts;
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startNode(): Promise<{ url: string; hits: () => number }> {
	let hits = 0;
	const server = createServer((_request, reply) => {
		hits += 1;
		reply.writeHead(200, { 'Content-Type': 'application/json' }).end('{"tag":"Idle"}');
	});
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits: () => hits };
}

describe('Host-backed Hydra HTTP destinations', () => {
	it('checks the Host policy on each request without changing standalone local clients', async () => {
		const node = await startNode();
		process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = '127.0.0.1';
		const guarded = new HydraHttpClient({
			httpUrl: node.url,
			authHeaders: {},
			timeoutMs: 1000,
			guardHostDestination: true,
		});
		await expect(guarded.get('/head')).resolves.toEqual({ tag: 'Idle' });
		process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = '';
		await expect(guarded.get('/head')).rejects.toMatchObject({ cause: { statusCode: 400 } });
		expect(node.hits()).toBe(1);

		const standalone = new HydraHttpClient({ httpUrl: node.url, authHeaders: {}, timeoutMs: 1000 });
		await expect(standalone.get('/head')).resolves.toEqual({ tag: 'Idle' });
		expect(node.hits()).toBe(2);
	});

	it('carries the Host policy through CustomHydraHead into its runtime client', async () => {
		const node = await startNode();
		process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = '';
		const head = new CustomHydraHead([{ httpUrl: node.url, walletId: 'wallet-1', guardHostDestination: true }]);
		await expect(head.mainNode.get('/head')).rejects.toMatchObject({ cause: { statusCode: 400 } });
		expect(node.hits()).toBe(0);
	});
});
