/**
 * Send one raw client input to a hydra-node WS API and print every frame seen
 * for a bounded window. Diagnostic driver for the persistence-recovery
 * experiments: Close attempts, snapshot sideload observation, NewTx, etc.
 *
 * Run: pnpm exec tsx hydra-l2-flow/99-ws-command.mts <ws-url> <seconds> [json-command]
 *   e.g. ...  ws://127.0.0.1:4001 15 '{"tag":"Close"}'
 *   omit json-command to just observe (Greetings etc.).
 */
import WebSocket from 'ws';

const url = process.argv[2] ?? 'ws://127.0.0.1:4001';
const seconds = Number(process.argv[3] ?? '10');
const command = process.argv[4];

const socket = new WebSocket(`${url}?history=no`);
socket.on('open', () => {
	console.log(`[ws] connected ${url}`);
	if (command) {
		socket.send(command);
		console.log(`[ws] sent ${command}`);
	}
});
socket.on('message', (raw: Buffer) => {
	const text = raw.toString('utf8');
	try {
		const parsed = JSON.parse(text) as Record<string, unknown>;
		const compact = JSON.stringify(parsed);
		console.log(`[frame] ${compact.length > 1200 ? compact.slice(0, 1200) + '…(' + compact.length + 'b)' : compact}`);
	} catch {
		console.log(`[frame-raw] ${text.slice(0, 300)}`);
	}
});
socket.on('error', (e: Error) => console.log(`[ws-error] ${e.message}`));
setTimeout(() => { socket.close(); process.exit(0); }, seconds * 1000);
