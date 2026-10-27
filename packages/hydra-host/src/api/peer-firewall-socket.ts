import { lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';

/** Keep the firewall helper on a private socket, away from the public TCP listener. */
export function createPeerFirewallSocketServer(controlPlane: Server): Server {
	return createServer((request, response) => {
		const isAllowlist = request.method === 'GET' && request.url === '/v1/peer-allowlist';
		const isAck = request.method === 'POST' && request.url === '/v1/peer-allowlist/applied';
		if (isAllowlist || isAck) {
			controlPlane.emit('request', request, response);
			return;
		}
		response.writeHead(404, { 'Content-Type': 'application/json' });
		response.end('{"error":"not found"}');
	});
}

/** The Host holds its data-volume lease before clearing a socket left by a crash. */
export function preparePeerFirewallSocket(socketPath: string): void {
	const owner = process.getuid?.();
	if (owner === undefined) throw new Error('the peer firewall control socket requires a Unix host');
	const directory = lstatSync(dirname(socketPath));
	if (!directory.isDirectory() || directory.uid !== owner || (directory.mode & 0o077) !== 0) {
		throw new Error('the peer firewall control socket directory must be owned by the Host user and private');
	}
	try {
		const existing = lstatSync(socketPath);
		if (!existing.isSocket() || existing.uid !== owner) {
			throw new Error('the peer firewall control socket path is not an owned socket');
		}
		unlinkSync(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
}
