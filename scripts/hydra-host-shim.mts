/**
 * Thin pass-through in front of a real Hydra Host, used only on developer
 * machines where hydra-node cannot execute.
 *
 * Everything is forwarded to the real container untouched except
 * `/v1/capabilities`, where the `scriptCatalogue` is filled in. On an arm64 Mac
 * `hydra-node --hydra-script-catalogue` dies with SIGILL under emulation, so the
 * Host correctly reports a probe error and the placement guard correctly refuses
 * to put a head there. That guard is right; this shim exists so the rest of the
 * handshake can still be exercised locally, and it must never be used anywhere
 * a real head is opened.
 */

import { createServer, request as httpRequest } from 'node:http';

const PORT = Number(process.env.SHIM_PORT ?? 18500);
const UPSTREAM = new URL(process.env.SHIM_UPSTREAM ?? 'http://127.0.0.1:18443');

function forward(
	method: string,
	path: string,
	headers: Record<string, string>,
	body: Buffer,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
	return new Promise((resolve, reject) => {
		const upstream = httpRequest(
			{ host: UPSTREAM.hostname, port: UPSTREAM.port, method, path, headers },
			(response) => {
				const chunks: Buffer[] = [];
				response.on('data', (chunk: Buffer) => chunks.push(chunk));
				response.on('end', () =>
					resolve({ status: response.statusCode ?? 502, headers: response.headers, body: Buffer.concat(chunks) }),
				);
			},
		);
		upstream.on('error', reject);
		if (body.length > 0) {
			upstream.write(body);
		}
		upstream.end();
	});
}

createServer((request, response) => {
	void (async () => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) {
			chunks.push(chunk as Buffer);
		}
		const body = Buffer.concat(chunks);
		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(request.headers)) {
			if (typeof value === 'string' && key.toLowerCase() !== 'host') {
				headers[key] = value;
			}
		}

		try {
			const upstream = await forward(request.method ?? 'GET', request.url ?? '/', headers, body);
			let payload = upstream.body;

			if (request.url === '/v1/capabilities' && upstream.status === 200) {
				const parsed = JSON.parse(payload.toString('utf8')) as Record<string, unknown>;
				// The one thing emulation cannot produce. Everything else — version,
				// ledger params hash, slot counts — comes from the real host.
				parsed.scriptCatalogue = { note: 'supplied by the local shim; hydra-node cannot run here' };
				parsed.probeError = null;
				payload = Buffer.from(JSON.stringify(parsed));
				console.log('[shim] filled in scriptCatalogue for /v1/capabilities');
			} else {
				console.log(`[shim] ${request.method} ${request.url} -> ${upstream.status}`);
			}

			response.writeHead(upstream.status, { 'Content-Type': 'application/json' });
			response.end(payload);
		} catch (error) {
			console.error('[shim] upstream failed:', (error as Error).message);
			response.writeHead(502, { 'Content-Type': 'application/json' });
			response.end(JSON.stringify({ error: 'shim upstream failed' }));
		}
	})();
}).listen(PORT, '127.0.0.1', () => console.log(`[shim] listening on :${PORT} -> ${UPSTREAM.origin}`));
