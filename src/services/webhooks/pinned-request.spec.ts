import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from '@jest/globals';
import { postPinnedWebhook } from './pinned-request';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('pinned webhook request', () => {
	it('posts to the validated IP without resolving the URL hostname again', async () => {
		let received: {
			host: string | undefined;
			path: string | undefined;
			body: string;
			length: string | undefined;
		} | null = null;
		const server = createServer(async (request, response) => {
			let body = '';
			for await (const chunk of request) body += chunk.toString();
			received = {
				host: request.headers.host,
				path: request.url,
				body,
				length: request.headers['content-length'],
			};
			response.writeHead(202).end();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;
		const body = JSON.stringify({ event: 'hydra-test' });

		const result = await postPinnedWebhook(
			{
				url: new URL(`http://rebind.invalid:${port}/webhook?secret=sample`),
				addresses: [{ address: '127.0.0.1', family: 4 }],
			},
			{ headers: { 'Content-Type': 'application/json' }, body },
			AbortSignal.timeout(1000),
		);

		expect(result).toEqual({ ok: true, status: 202, statusText: 'Accepted' });
		expect(received).toEqual({
			host: `rebind.invalid:${port}`,
			path: '/webhook?secret=sample',
			body,
			length: Buffer.byteLength(body).toString(),
		});
	});

	it('does not follow a redirect to a second destination', async () => {
		let requests = 0;
		const server = createServer((_request, response) => {
			requests += 1;
			response.writeHead(302, { Location: '/second' }).end();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const port = (server.address() as { port: number }).port;

		const result = await postPinnedWebhook(
			{
				url: new URL(`http://rebind.invalid:${port}/first`),
				addresses: [{ address: '127.0.0.1', family: 4 }],
			},
			{ headers: {}, body: '{}' },
			AbortSignal.timeout(1000),
		);

		expect(result.ok).toBe(false);
		expect(result.status).toBe(302);
		expect(requests).toBe(1);
	});
});
