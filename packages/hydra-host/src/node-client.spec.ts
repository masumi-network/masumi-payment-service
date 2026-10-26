/**
 * The probe budget is the supervisor's only protection against a wedged node.
 *
 * Every reconcile probe runs inside `runTick`, which cannot resolve until all
 * of its workers do, and `shutdown()` waits on the same tick. So a probe that
 * outlives its declared timeout does not just delay one node — it stops the
 * host reconciling any of them and then blocks SIGTERM behind the same wait.
 * The case that matters is a node that answers headers and then stops writing:
 * it is alive enough to accept the connection and dead enough to never finish.
 */

import { describe, expect, it, afterEach } from '@jest/globals';
import { createServer, type Server } from 'node:http';

import { NodeResponseError } from './errors.js';
import { NodeClient } from './node-client.js';

/** One byte beyond the payment service's established Hydra HTTP response cap. */
const OVERSIZED_NODE_RESPONSE_BYTES = 4 * 1024 * 1024 + 1;
const RESPONSE_CLOSE_TIMEOUT_MS = 1_000;

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address == null || typeof address === 'string') throw new Error('no port');
	return address.port;
}

describe('NodeClient probe budget', () => {
	it('gives up on a node that sends headers and then stops writing', async () => {
		// Content-Length promises more than is ever written, so the response is
		// open forever from the client's point of view.
		const port = await listen((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json', 'content-length': '64' });
			response.write('{');
		});

		const started = Date.now();
		await expect(new NodeClient(port).isResponsive()).resolves.toBe(false);
		// The declared budget is 5s. Anything on the order of undici's 300s
		// bodyTimeout means the timer was cleared once headers arrived.
		expect(Date.now() - started).toBeLessThan(15_000);
	}, 30_000);

	it('reads a complete body normally', async () => {
		const port = await listen((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end('{"ok":true}');
		});

		await expect(new NodeClient(port).isResponsive()).resolves.toBe(true);
	});

	it('refuses a streamed snapshot larger than the response limit', async () => {
		const oversizedSnapshot = JSON.stringify({ payload: 'x'.repeat(OVERSIZED_NODE_RESPONSE_BYTES) });
		const port = await listen((_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' });
			response.end(oversizedSnapshot);
		});

		await expect(new NodeClient(port).fetchConfirmedSnapshot()).rejects.toBeInstanceOf(NodeResponseError);
	});

	it('closes a stalled response when its declared length exceeds the limit', async () => {
		let responseClosed!: () => void;
		const closed = new Promise<boolean>((resolve) => {
			responseClosed = () => resolve(true);
		});
		const port = await listen((_request, response) => {
			response.once('close', responseClosed);
			response.writeHead(200, {
				'content-type': 'application/json',
				'content-length': String(OVERSIZED_NODE_RESPONSE_BYTES),
			});
			response.write('{');
		});

		await expect(new NodeClient(port).fetchConfirmedSnapshot()).rejects.toBeInstanceOf(NodeResponseError);
		let timer!: ReturnType<typeof setTimeout>;
		try {
			const timedOut = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), RESPONSE_CLOSE_TIMEOUT_MS);
			});
			expect(await Promise.race([closed, timedOut])).toBe(true);
		} finally {
			clearTimeout(timer);
		}
	});
});
