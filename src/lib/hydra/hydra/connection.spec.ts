import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

class WsMock extends EventEmitter {
	readyState = 1;
	readonly send = jest.fn<(data: string) => void>();
	readonly pause = jest.fn<() => void>();
	readonly resume = jest.fn<() => void>();
	readonly ping = jest.fn<() => void>();
	readonly close = jest.fn<(code?: number) => void>().mockImplementation((code) => {
		queueMicrotask(() => {
			this.readyState = 3;
			this.emit('close', code ?? 1000, Buffer.alloc(0));
		});
	});
	readonly terminate = jest.fn<() => void>().mockImplementation(() => {
		this.readyState = 3;
	});
}

const makeWsMock = (): WsMock => new WsMock();

let currentWsMock: WsMock = makeWsMock();

type MockWebSocketConstructor = (url: string, options?: { maxPayload?: number; perMessageDeflate?: boolean }) => WsMock;

const MockWebSocket = jest.fn<MockWebSocketConstructor>().mockImplementation(() => {
	currentWsMock = makeWsMock();
	return currentWsMock;
});

// WebSocket.OPEN constant needed by disconnect() and send()
(MockWebSocket as unknown as { OPEN: number }).OPEN = 1;
(MockWebSocket as unknown as { CONNECTING: number }).CONNECTING = 0;
(MockWebSocket as unknown as { CLOSING: number }).CLOSING = 2;
(MockWebSocket as unknown as { CLOSED: number }).CLOSED = 3;

jest.unstable_mockModule('ws', () => ({ default: MockWebSocket }));

const { Connection, toWebSocketUrl } = await import('./connection');
const { sendHydraCommandAndWait } = await import('./node-command-channel');
const { HydraTransportError, HydraTransportAmbiguousError } = await import('./errors');

const connections = new Set<InstanceType<typeof Connection>>();

function createConnection(url = 'ws://localhost:4001') {
	const connection = new Connection(url);
	connections.add(connection);
	return connection;
}

describe('Connection', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		currentWsMock = makeWsMock();
		MockWebSocket.mockImplementation(() => {
			currentWsMock = makeWsMock();
			return currentWsMock;
		});
		jest.spyOn(Math, 'random').mockReturnValue(0.5);
	});

	afterEach(async () => {
		jest.useRealTimers();
		// Real heartbeat timers outlive the test VM unless their connection closes.
		await Promise.all([...connections].map((connection) => connection.disconnect()));
		connections.clear();
		jest.restoreAllMocks();
	});

	it('starts disconnected', () => {
		const conn = createConnection();
		expect(conn.isOpen()).toBe(false);
	});

	it('connect() creates a WebSocket converting http to ws', async () => {
		const conn = createConnection('http://localhost:4001');
		await conn.connect();
		expect(MockWebSocket.mock.calls[0]?.[0]).toBe('ws://localhost:4001');
	});

	it('passes a pre-allocation frame limit to transports that support maxPayload', async () => {
		const conn = createConnection();
		await conn.connect();
		expect(MockWebSocket.mock.calls[0]).toEqual([
			'ws://localhost:4001',
			{ maxPayload: 4 * 1024 * 1024, perMessageDeflate: false },
		]);
	});

	it('connect() passes ws:// URLs unchanged', async () => {
		const conn = createConnection();
		await conn.connect();
		expect(MockWebSocket.mock.calls[0]?.[0]).toBe('ws://localhost:4001');
	});

	it('isOpen() returns false before onopen fires', async () => {
		const conn = createConnection();
		await conn.connect();
		expect(conn.isOpen()).toBe(false);
	});

	it('pauses and resumes reading on the current socket', async () => {
		const conn = createConnection();
		conn.pauseReceiving();
		await conn.connect();
		conn.pauseReceiving();
		conn.resumeReceiving();
		expect(currentWsMock.pause).toHaveBeenCalledTimes(1);
		expect(currentWsMock.resume).toHaveBeenCalledTimes(1);
	});

	describe('heartbeat', () => {
		const HEARTBEAT_MS = 30_000;

		async function openConnection() {
			jest.useFakeTimers();
			const conn = createConnection();
			const closes: Error[] = [];
			conn.on('close', (error: Error) => closes.push(error));
			await conn.connect();
			const socket = currentWsMock;
			socket.emit('open');
			return { conn, socket, closes };
		}

		// Regression: a history socket whose peer vanished without closing stayed
		// OPEN for a day, so replay counted as complete while no confirmation came.
		it('fails a socket whose peer stops answering pings, and reconnects', async () => {
			const { conn, socket, closes } = await openConnection();
			const socketsBefore = MockWebSocket.mock.calls.length;

			jest.advanceTimersByTime(HEARTBEAT_MS * 2);
			expect(socket.ping).toHaveBeenCalledTimes(2);
			expect(conn.isOpen()).toBe(true);

			jest.advanceTimersByTime(HEARTBEAT_MS);
			expect(conn.isOpen()).toBe(false);
			expect(closes[0]?.message).toContain('answered no ping');
			expect(socket.close).toHaveBeenCalledWith(1011);

			jest.advanceTimersByTime(1100);
			expect(MockWebSocket.mock.calls.length).toBe(socketsBefore + 1);
		});

		it('keeps a socket whose peer answers every ping', async () => {
			const { conn, socket, closes } = await openConnection();
			for (let tick = 0; tick < 5; tick += 1) {
				jest.advanceTimersByTime(HEARTBEAT_MS);
				socket.emit('pong');
			}
			expect(socket.ping).toHaveBeenCalledTimes(5);
			expect(conn.isOpen()).toBe(true);
			expect(closes).toHaveLength(0);
		});

		it('tolerates one silent interval, as a pong can queue behind a large frame', async () => {
			const { conn, socket } = await openConnection();
			jest.advanceTimersByTime(HEARTBEAT_MS * 2);
			socket.emit('pong');
			jest.advanceTimersByTime(HEARTBEAT_MS * 2);
			expect(conn.isOpen()).toBe(true);
		});

		it('counts any inbound frame as proof the path is alive', async () => {
			const { conn, socket } = await openConnection();
			for (let tick = 0; tick < 6; tick += 1) {
				jest.advanceTimersByTime(HEARTBEAT_MS);
				socket.emit('message', Buffer.from('{}'), false);
			}
			expect(conn.isOpen()).toBe(true);
		});

		it('does not start the heartbeat before the socket opens', async () => {
			jest.useFakeTimers();
			const conn = createConnection();
			await conn.connect();
			jest.advanceTimersByTime(HEARTBEAT_MS * 3);
			expect(currentWsMock.ping).not.toHaveBeenCalled();
		});

		it('counts the peer pinging us as proof the path is alive', async () => {
			const { conn, socket } = await openConnection();
			for (let tick = 0; tick < 4; tick += 1) {
				jest.advanceTimersByTime(HEARTBEAT_MS);
				socket.emit('ping');
			}
			expect(conn.isOpen()).toBe(true);
		});

		it('does not fail a socket paused for backpressure, which cannot read pongs', async () => {
			const { conn, socket } = await openConnection();
			conn.pauseReceiving();
			jest.advanceTimersByTime(HEARTBEAT_MS * 4);
			expect(conn.isOpen()).toBe(true);
			expect(socket.ping).not.toHaveBeenCalled();

			conn.resumeReceiving();
			jest.advanceTimersByTime(HEARTBEAT_MS * 2);
			expect(socket.ping).toHaveBeenCalledTimes(2);
			expect(conn.isOpen()).toBe(true);
			jest.advanceTimersByTime(HEARTBEAT_MS);
			expect(conn.isOpen()).toBe(false);
		});

		it('stops pinging after a manual disconnect', async () => {
			const { conn, socket } = await openConnection();
			const disconnected = conn.disconnect();
			await jest.advanceTimersByTimeAsync(0);
			await disconnected;
			jest.advanceTimersByTime(HEARTBEAT_MS * 3);
			expect(socket.ping).not.toHaveBeenCalled();
		});
	});

	// Math.random is pinned to 0.5, so the jitter is zero and each delay is exact.
	describe('reconnect backoff', () => {
		const HEARTBEAT_MS = 30_000;

		async function startConnection() {
			jest.useFakeTimers();
			const conn = createConnection();
			await conn.connect();
			return conn;
		}

		function msUntilNextSocket(): number {
			const sockets = MockWebSocket.mock.calls.length;
			let waitedMs = 0;
			while (MockWebSocket.mock.calls.length === sockets && waitedMs < 60_000) {
				jest.advanceTimersByTime(100);
				waitedMs += 100;
			}
			return waitedMs;
		}

		function refuseRightAfterOpen(conn: InstanceType<typeof Connection>, times: number): number[] {
			return Array.from({ length: times }, () => {
				currentWsMock.emit('open');
				conn.invalidate(new HydraTransportError('history replay failed'));
				return msUntilNextSocket();
			});
		}

		// Regression: the delay reset on every open, so a history whose replay
		// fails reconnected and replayed about once a second for good.
		it('grows the delay for a socket refused right after it opens', async () => {
			const conn = await startConnection();
			expect(refuseRightAfterOpen(conn, 4)).toEqual([1000, 2000, 4000, 8000]);
		});

		const refusals: [string, (conn: InstanceType<typeof Connection>) => void][] = [
			['its owner invalidates it', (conn) => conn.invalidate(new HydraTransportError('history replay failed'))],
			['it sends a binary frame', () => currentWsMock.emit('message', Buffer.from('x'), true)],
			[
				'ws refuses a malformed frame',
				() =>
					currentWsMock.emit(
						'error',
						Object.assign(new Error('Invalid UTF-8 sequence'), { code: 'WS_ERR_INVALID_UTF8' }),
					),
			],
			[
				'ws refuses an oversized frame',
				() =>
					currentWsMock.emit(
						'error',
						Object.assign(new RangeError('Max payload size exceeded'), {
							code: 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH',
						}),
					),
			],
		];
		it.each(refusals)('grows the delay for a proven socket when %s', async (_name, refuse) => {
			const conn = await startConnection();
			const delays = Array.from({ length: 3 }, () => {
				currentWsMock.emit('open');
				jest.advanceTimersByTime(HEARTBEAT_MS * 1.5);
				refuse(conn);
				return msUntilNextSocket();
			});
			expect(delays).toEqual([1000, 2000, 4000]);
		});

		it('forgets earlier failures once a socket has worked for five minutes', async () => {
			const conn = await startConnection();
			refuseRightAfterOpen(conn, 3);
			currentWsMock.emit('open');
			for (let interval = 0; interval < 10; interval++) {
				jest.advanceTimersByTime(HEARTBEAT_MS);
				currentWsMock.emit('pong');
			}
			conn.invalidate(new HydraTransportError('history replay failed'));
			expect(msUntilNextSocket()).toBe(1000);
		});

		const drops: [string, () => void][] = [
			['closes', () => currentWsMock.emit('close', 1006, Buffer.alloc(0))],
			['fails', () => currentWsMock.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))],
		];
		it.each(drops)('reconnects on the first step when a proven socket %s', async (_name, drop) => {
			const conn = await startConnection();
			refuseRightAfterOpen(conn, 3);
			currentWsMock.emit('open');
			jest.advanceTimersByTime(HEARTBEAT_MS);
			drop();
			expect(msUntilNextSocket()).toBe(1000);
		});

		it('keeps growing the delay when a socket drops before it is proven', async () => {
			const conn = await startConnection();
			refuseRightAfterOpen(conn, 3);
			currentWsMock.emit('open');
			currentWsMock.emit('close', 1006, Buffer.alloc(0));
			expect(msUntilNextSocket()).toBe(8000);
		});

		it('reconnects on the first step after a deliberate restart', async () => {
			const conn = await startConnection();
			refuseRightAfterOpen(conn, 3);
			currentWsMock.emit('open');
			conn.restart(new HydraTransportError('history page reconciled; restarting replay'));
			expect(msUntilNextSocket()).toBe(1000);
		});
	});

	it('isOpen() returns true after WebSocket fires onopen', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		expect(conn.isOpen()).toBe(true);
	});

	it('waitUntilOpen() resolves only after the socket opens', async () => {
		const conn = createConnection();
		let didResolve = false;
		const ready = conn.waitUntilOpen(1000).then(() => {
			didResolve = true;
		});
		await Promise.resolve();
		expect(didResolve).toBe(false);

		currentWsMock.emit('open');

		await ready;
		expect(didResolve).toBe(true);
	});

	it('waitUntilOpen() rejects a pre-open transport failure', async () => {
		const conn = createConnection();
		const ready = conn.waitUntilOpen(1000);
		const rejection = expect(ready).rejects.toThrow('closed unexpectedly');

		currentWsMock.emit('close', 1006, Buffer.alloc(0));

		await rejection;
	});

	// Without the code, a node that refused the socket read as "WebSocket error: " and named nothing.
	it('waitUntilOpen() names a refused connect that has only a code', async () => {
		const conn = createConnection();
		const ready = conn.waitUntilOpen(1000);
		const rejection = expect(ready).rejects.toThrow('WebSocket error: ECONNREFUSED');

		currentWsMock.emit('error', Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' }));

		await rejection;
	});

	it('waitUntilOpen() has a bounded timeout', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		const ready = conn.waitUntilOpen(1000);
		const rejection = expect(ready).rejects.toThrow('did not open within 1000ms');

		jest.advanceTimersByTime(1000);

		await rejection;
	});

	it('connect() is idempotent — second call does not create another WebSocket', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const callsBefore = MockWebSocket.mock.calls.length;
		await conn.connect(); // status is Connected, not Disconnected — should no-op
		expect(MockWebSocket.mock.calls.length).toBe(callsBefore);
	});

	it('emits message event when WebSocket receives data', async () => {
		const conn = createConnection();
		await conn.connect();
		const listener = jest.fn<(data: string) => void>();
		conn.on('message', listener);
		currentWsMock.emit('message', Buffer.from('{"tag":"HeadIsOpen"}'), false);
		expect(listener).toHaveBeenCalledWith('{"tag":"HeadIsOpen"}');
	});

	it('emits close event when WebSocket closes with code 1006', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const closeListener = jest.fn<(err: unknown) => void>();
		conn.on('close', closeListener);
		currentWsMock.emit('close', 1006, Buffer.alloc(0));
		// Allow onerror async to run
		await Promise.resolve();
		expect(closeListener).toHaveBeenCalled();
	});

	it('schedules reconnect when WebSocket closes with code 1006 and status is Connected', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const callsBefore = MockWebSocket.mock.calls.length;
		currentWsMock.emit('close', 1006, Buffer.alloc(0));
		await Promise.resolve();
		jest.advanceTimersByTime(1100);
		expect(MockWebSocket.mock.calls.length).toBe(callsBefore + 1);
	});

	it('cancels an abnormal-close reconnect when manually disconnected', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const callsBefore = MockWebSocket.mock.calls.length;
		currentWsMock.emit('close', 1006, Buffer.alloc(0));
		await Promise.resolve();
		await conn.disconnect();
		jest.advanceTimersByTime(1100);
		expect(MockWebSocket.mock.calls.length).toBe(callsBefore);
	});

	it('emits close and schedules reconnect for non-manual server close codes', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const closeListener = jest.fn<(err: unknown) => void>();
		conn.on('close', closeListener);
		const callsBefore = MockWebSocket.mock.calls.length;
		currentWsMock.emit('close', 1012, Buffer.alloc(0));
		await Promise.resolve();
		expect(closeListener).toHaveBeenCalled();
		jest.advanceTimersByTime(1100);
		expect(MockWebSocket.mock.calls.length).toBe(callsBefore + 1);
	});

	it('disconnect() closes the WebSocket normally when socket is OPEN', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.readyState = 1; // OPEN
		await conn.disconnect();
		expect(currentWsMock.close).toHaveBeenCalledWith(1000);
		expect(conn.isOpen()).toBe(false);
	});

	it('disconnect() drains current-generation text frames until the close handshake completes', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.close.mockImplementationOnce(() => undefined);
		const messageListener = jest.fn<(data: string) => void>();
		conn.on('message', messageListener);

		let didDisconnect = false;
		const disconnecting = conn.disconnect().then(() => {
			didDisconnect = true;
		});
		await Promise.resolve();
		expect(didDisconnect).toBe(false);

		currentWsMock.emit('message', Buffer.from('{"tag":"Greetings","headStatus":"Idle"}'), false);
		expect(messageListener).toHaveBeenCalledWith('{"tag":"Greetings","headStatus":"Idle"}');

		currentWsMock.readyState = 3;
		currentWsMock.emit('close', 1000, Buffer.alloc(0));
		await disconnecting;
		expect(didDisconnect).toBe(true);

		currentWsMock.emit('message', Buffer.from('{"tag":"HeadIsOpen"}'), false);
		expect(messageListener).toHaveBeenCalledTimes(1);
	});

	it('disconnect() terminates a socket that does not complete its close handshake', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.close.mockImplementationOnce(() => undefined);

		const disconnecting = conn.disconnect();
		jest.advanceTimersByTime(1000);
		await disconnecting;

		expect(currentWsMock.terminate).toHaveBeenCalledTimes(1);
		expect(conn.isOpen()).toBe(false);
	});

	it('rejects new commands while a graceful disconnect is draining', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.close.mockImplementationOnce(() => undefined);

		const disconnecting = conn.disconnect();
		await expect(conn.send({ tag: 'NewTx' })).rejects.toThrow('disconnecting; command not sent');
		expect(currentWsMock.send).not.toHaveBeenCalled();
		currentWsMock.readyState = 3;
		currentWsMock.emit('close', 1000, Buffer.alloc(0));
		await disconnecting;
	});

	it('disconnect() closes a CONNECTING socket and prevents a stale onopen', async () => {
		const conn = createConnection();
		await conn.connect();
		const staleSocket = currentWsMock;
		currentWsMock.readyState = 0; // CONNECTING
		await conn.disconnect();
		expect(currentWsMock.close).toHaveBeenCalledWith(1000);
		staleSocket.emit('open');
		expect(conn.isOpen()).toBe(false);
	});

	it('reconnects when the WebSocket error callback fires without onclose', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const callsBefore = MockWebSocket.mock.calls.length;
		currentWsMock.emit('error', new Error('test transport error'));
		jest.advanceTimersByTime(1100);
		expect(MockWebSocket.mock.calls.length).toBe(callsBefore + 1);
	});

	it('closes and invalidates a stale socket when onerror fires without onclose', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		const staleSocket = currentWsMock;
		staleSocket.emit('open');
		staleSocket.emit('error', new Error('test transport error'));
		expect(staleSocket.close).toHaveBeenCalledWith(1011);
		expect(() => staleSocket.emit('error', new Error('late stale-socket error'))).not.toThrow();
		jest.advanceTimersByTime(1100);
		staleSocket.emit('message', Buffer.from('{"tag":"HeadIsOpen"}'), false);
		expect(conn.isOpen()).toBe(false);
	});

	it('disconnect() is a no-op when already disconnected', async () => {
		const conn = createConnection();
		await conn.disconnect(); // status is already Disconnected
		expect(currentWsMock.close).not.toHaveBeenCalled();
	});

	it('send() resolves after queuing on an OPEN socket', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.readyState = 1; // OPEN
		await expect(conn.send({ tag: 'Init' })).resolves.toBeUndefined();
		expect(currentWsMock.send).toHaveBeenCalled();
	});

	it('send() queues immediately when the socket is already OPEN', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.readyState = 1; // OPEN
		const sendPromise = conn.send({ tag: 'Init' });
		expect(currentWsMock.send).toHaveBeenCalledTimes(1);
		await sendPromise;
	});

	it('cancels a waiting send before a shorter command deadline releases its reservation', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.readyState = 0;
		const command = sendHydraCommandAndWait(conn, undefined, {
			command: 'NewTx',
			payload: { tag: 'NewTx' },
			timeoutMs: 20,
			isComplete: () => false,
			timeoutMessage: 'command deadline',
		});
		const rejection = expect(command).rejects.toBeInstanceOf(HydraTransportError);
		await jest.advanceTimersByTimeAsync(20);
		await rejection;
		currentWsMock.readyState = 1;
		currentWsMock.emit('open');
		await jest.advanceTimersByTimeAsync(5000);
		expect(currentWsMock.send).not.toHaveBeenCalled();
		expect(conn.listenerCount('close')).toBe(0);
	});

	it('keeps a dispatched command ambiguous when its deadline expires before promise reactions', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		const command = sendHydraCommandAndWait(conn, undefined, {
			command: 'NewTx',
			payload: { tag: 'NewTx' },
			timeoutMs: 20,
			isComplete: () => false,
			timeoutMessage: 'command deadline',
		});
		const rejection = expect(command).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
		// Synchronous timer advancement deliberately leaves the send promise pending.
		jest.advanceTimersByTime(20);
		await rejection;
		expect(currentWsMock.send).toHaveBeenCalledTimes(1);
	});

	it('does not send when cancellation already happened', async () => {
		const conn = createConnection();
		await conn.connect();
		const controller = new AbortController();
		controller.abort();
		await expect(conn.send({ tag: 'NewTx' }, { signal: controller.signal })).rejects.toThrow('cancelled');
		expect(currentWsMock.send).not.toHaveBeenCalled();
	});

	it('send() rejects after 5 seconds if socket never reaches OPEN state', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.readyState = 0; // CONNECTING — not open
		const sendPromise = conn.send({ tag: 'Init' });
		jest.advanceTimersByTime(6000);
		await expect(sendPromise).rejects.toThrow('command not sent');
		expect(currentWsMock.send).not.toHaveBeenCalled();
	});

	it('send() stops retrying after successful send', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.readyState = 0;
		const sendPromise = conn.send({ tag: 'Init' });
		currentWsMock.readyState = 1;
		currentWsMock.emit('open');
		jest.advanceTimersByTime(100);
		await sendPromise;
		const callsAfterFirst = currentWsMock.send.mock.calls.length;
		jest.advanceTimersByTime(2000); // additional ticks — should not send again
		expect(currentWsMock.send.mock.calls.length).toBe(callsAfterFirst);
	});

	it('rejects a waiting send immediately when the transport closes', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.readyState = 0;
		const sendPromise = conn.send({ tag: 'NewTx' });
		currentWsMock.emit('close', 1006, Buffer.alloc(0));
		await expect(sendPromise).rejects.toThrow('before the command could be queued');
	});

	it('rejects oversized inbound frames without emitting their contents', async () => {
		jest.useFakeTimers();
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const listener = jest.fn<(data: string) => void>();
		conn.on('message', listener);
		currentWsMock.emit('message', Buffer.from('x'.repeat(4 * 1024 * 1024 + 1)), false);
		expect(listener).not.toHaveBeenCalled();
		expect(conn.isOpen()).toBe(false);
	});

	it('rejects binary frames without exposing them as protocol messages', async () => {
		const conn = createConnection();
		await conn.connect();
		currentWsMock.emit('open');
		const listener = jest.fn<(data: string) => void>();
		conn.on('message', listener);

		currentWsMock.emit('message', Buffer.from('{"tag":"HeadIsOpen"}'), true);

		expect(listener).not.toHaveBeenCalled();
		expect(conn.isOpen()).toBe(false);
	});
});

// A bare `replace('http', 'ws')` rewrites the first `http` anywhere in the URL,
// and by the time a URL reaches the socket its scheme is already ws/wss — so
// the only thing left for it to corrupt is the host, path or query.
describe('toWebSocketUrl', () => {
	it('leaves an already-ws URL exactly as it is, host included', () => {
		expect(toWebSocketUrl('wss://hydra-http-1.internal:4001?history=no')).toBe(
			'wss://hydra-http-1.internal:4001?history=no',
		);
		expect(toWebSocketUrl('ws://http-node.example:4001/http/api')).toBe('ws://http-node.example:4001/http/api');
	});

	it('upgrades an http URL by scheme only', () => {
		expect(toWebSocketUrl('http://hydra-http-1.internal:4001')).toBe('ws://hydra-http-1.internal:4001');
		expect(toWebSocketUrl('https://hydra-http-1.internal:4001')).toBe('wss://hydra-http-1.internal:4001');
	});
});
