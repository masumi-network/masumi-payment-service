import { afterEach, expect, it } from '@jest/globals';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import { NodeClient } from './node-client.js';

const OVERSIZED_GREETING_BYTES = 4 * 1024 * 1024 + 1;
const GREETING = { tag: 'Greetings', chainSyncedStatus: 'InSync', currentSlot: 123 };
const servers: Array<{ http: Server; websocket: WebSocketServer }> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.terminate();
	for (const { http, websocket } of servers.splice(0)) {
		await new Promise<void>((resolve) => websocket.close(() => resolve()));
		http.closeAllConnections();
		await new Promise<void>((resolve) => http.close(() => resolve()));
	}
});

async function listen(onConnection: (socket: WebSocket, request: IncomingMessage) => void): Promise<number> {
	const http = createServer();
	const websocket = new WebSocketServer({ server: http });
	servers.push({ http, websocket });
	websocket.on('connection', (socket, request) => {
		sockets.push(socket);
		onConnection(socket, request);
	});
	await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
	const address = http.address();
	if (address === null || typeof address === 'string') throw new Error('no listening port');
	return address.port;
}

it('requests chain state without replay history or the snapshot UTxO', async () => {
	let requestedUrl = '';
	const port = await listen((socket, request) => {
		requestedUrl = request.url ?? '';
		socket.send(JSON.stringify(GREETING));
	});

	await expect(new NodeClient(port).probeChain()).resolves.toEqual({ synced: true, slot: GREETING.currentSlot });
	const query = new URL(requestedUrl, 'http://127.0.0.1').searchParams;
	expect(query.get('history')).toBe('no');
	expect(query.get('snapshot-utxo')).toBe('no');
});

it('rejects an oversized Greetings frame before parsing its chain state', async () => {
	const port = await listen((socket) => {
		socket.send(JSON.stringify({ ...GREETING, payload: 'x'.repeat(OVERSIZED_GREETING_BYTES) }));
	});

	await expect(new NodeClient(port).probeChain()).resolves.toEqual({ synced: false, slot: null });
});
