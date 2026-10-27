import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPeerFirewallSocketServer, preparePeerFirewallSocket } from './peer-firewall-socket.js';

let directory: string;
let socket: Server | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), 'hydra-control-socket-'));
});

afterEach(async () => {
	if (socket?.listening) await new Promise<void>((resolve) => socket?.close(() => resolve()));
	rmSync(directory, { recursive: true, force: true });
});

function callSocket(path: string, method: string, route: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const call = request({ socketPath: path, path: route, method }, (response) => {
			let body = '';
			response.setEncoding('utf8');
			response.on('data', (chunk: string) => (body += chunk));
			response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
		});
		call.on('error', reject);
		call.end();
	});
}

describe('private peer firewall control socket', () => {
	it('forwards only the allowlist and acknowledgement routes', async () => {
		const path = join(directory, 'control.sock');
		const target = createServer((_request, response) => response.end('allowlist'));
		preparePeerFirewallSocket(path);
		socket = createPeerFirewallSocketServer(target);
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => reject(error);
			socket?.once('error', onError);
			socket?.listen(path, () => {
				socket?.off('error', onError);
				resolve();
			});
		});
		expect(await callSocket(path, 'GET', '/v1/peer-allowlist')).toEqual({ status: 200, body: 'allowlist' });
		expect(await callSocket(path, 'POST', '/v1/peer-allowlist/applied')).toEqual({ status: 200, body: 'allowlist' });
		expect(await callSocket(path, 'GET', '/v1/capabilities')).toEqual({
			status: 404,
			body: '{"error":"not found"}',
		});
	});

	it('refuses a public directory or a regular file at the socket path', () => {
		const path = join(directory, 'control.sock');
		chmodSync(directory, 0o755);
		expect(() => preparePeerFirewallSocket(path)).toThrow(/directory must be owned by the Host user and private/);
		chmodSync(directory, 0o700);
		writeFileSync(path, 'do not remove');
		expect(() => preparePeerFirewallSocket(path)).toThrow(/path is not an owned socket/);
	});
});
