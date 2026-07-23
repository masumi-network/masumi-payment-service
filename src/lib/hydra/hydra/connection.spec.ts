import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';

class WsMock extends EventEmitter {
	readyState = 1;
	readonly send = jest.fn<(data: string) => void>();
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

const { Connection } = await import('./connection');

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

	afterEach(() => {
		jest.useRealTimers();
		jest.restoreAllMocks();
	});

	it('starts disconnected', () => {
		const conn = new Connection('ws://localhost:4001');
		expect(conn.isOpen()).toBe(false);
	});

	it('connect() creates a WebSocket converting http to ws', async () => {
		const conn = new Connection('http://localhost:4001');
		await conn.connect();
		expect(MockWebSocket.mock.calls[0]?.[0]).toBe('ws://localhost:4001');
	});

	it('passes a pre-allocation frame limit to transports that support maxPayload', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		expect(MockWebSocket.mock.calls[0]).toEqual([
			'ws://localhost:4001',
			{ maxPayload: 4 * 1024 * 1024, perMessageDeflate: false },
		]);
	});

	it('connect() passes ws:// URLs unchanged', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		expect(MockWebSocket.mock.calls[0]?.[0]).toBe('ws://localhost:4001');
	});

	it('isOpen() returns false before onopen fires', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		expect(conn.isOpen()).toBe(false);
	});

	it('isOpen() returns true after WebSocket fires onopen', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		expect(conn.isOpen()).toBe(true);
	});

	it('waitUntilOpen() resolves only after the socket opens', async () => {
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
		const ready = conn.waitUntilOpen(1000);
		const rejection = expect(ready).rejects.toThrow('closed unexpectedly');

		currentWsMock.emit('close', 1006, Buffer.alloc(0));

		await rejection;
	});

	it('waitUntilOpen() has a bounded timeout', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		const ready = conn.waitUntilOpen(1000);
		const rejection = expect(ready).rejects.toThrow('did not open within 1000ms');

		jest.advanceTimersByTime(1000);

		await rejection;
	});

	it('connect() is idempotent — second call does not create another WebSocket', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		const callsBefore = MockWebSocket.mock.calls.length;
		await conn.connect(); // status is Connected, not Disconnected — should no-op
		expect(MockWebSocket.mock.calls.length).toBe(callsBefore);
	});

	it('emits message event when WebSocket receives data', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		const listener = jest.fn<(data: string) => void>();
		conn.on('message', listener);
		currentWsMock.emit('message', Buffer.from('{"tag":"HeadIsOpen"}'), false);
		expect(listener).toHaveBeenCalledWith('{"tag":"HeadIsOpen"}');
	});

	it('emits close event when WebSocket closes with code 1006', async () => {
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.readyState = 1; // OPEN
		await conn.disconnect();
		expect(currentWsMock.close).toHaveBeenCalledWith(1000);
		expect(conn.isOpen()).toBe(false);
	});

	it('disconnect() drains current-generation text frames until the close handshake completes', async () => {
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		const callsBefore = MockWebSocket.mock.calls.length;
		currentWsMock.emit('error', new Error('test transport error'));
		jest.advanceTimersByTime(1100);
		expect(MockWebSocket.mock.calls.length).toBe(callsBefore + 1);
	});

	it('closes and invalidates a stale socket when onerror fires without onclose', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
		await conn.disconnect(); // status is already Disconnected
		expect(currentWsMock.close).not.toHaveBeenCalled();
	});

	it('send() resolves after queuing on an OPEN socket', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.readyState = 1; // OPEN
		await expect(conn.send({ tag: 'Init' })).resolves.toBeUndefined();
		expect(currentWsMock.send).toHaveBeenCalled();
	});

	it('send() queues immediately when the socket is already OPEN', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		currentWsMock.readyState = 1; // OPEN
		const sendPromise = conn.send({ tag: 'Init' });
		expect(currentWsMock.send).toHaveBeenCalledTimes(1);
		await sendPromise;
	});

	it('send() rejects after 5 seconds if socket never reaches OPEN state', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.readyState = 0; // CONNECTING — not open
		const sendPromise = conn.send({ tag: 'Init' });
		jest.advanceTimersByTime(6000);
		await expect(sendPromise).rejects.toThrow('command not sent');
		expect(currentWsMock.send).not.toHaveBeenCalled();
	});

	it('send() stops retrying after successful send', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
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
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.readyState = 0;
		const sendPromise = conn.send({ tag: 'NewTx' });
		currentWsMock.emit('close', 1006, Buffer.alloc(0));
		await expect(sendPromise).rejects.toThrow('before the command could be queued');
	});

	it('rejects oversized inbound frames without emitting their contents', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		const listener = jest.fn<(data: string) => void>();
		conn.on('message', listener);
		currentWsMock.emit('message', Buffer.from('x'.repeat(4 * 1024 * 1024 + 1)), false);
		expect(listener).not.toHaveBeenCalled();
		expect(conn.isOpen()).toBe(false);
	});

	it('rejects binary frames without exposing them as protocol messages', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.emit('open');
		const listener = jest.fn<(data: string) => void>();
		conn.on('message', listener);

		currentWsMock.emit('message', Buffer.from('{"tag":"HeadIsOpen"}'), true);

		expect(listener).not.toHaveBeenCalled();
		expect(conn.isOpen()).toBe(false);
	});
});
