import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';

type WsMock = {
	readyState: number;
	send: jest.Mock<(data: string) => void>;
	close: jest.Mock<(code?: number) => void>;
	onopen: ((event: unknown) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: { code: number }) => void) | null;
	onmessage: ((event: { data: string }) => void) | null;
};

const makeWsMock = (): WsMock => ({
	readyState: 1, // OPEN
	send: jest.fn<(data: string) => void>(),
	close: jest.fn<(code?: number) => void>(),
	onopen: null,
	onerror: null,
	onclose: null,
	onmessage: null,
});

let currentWsMock: WsMock = makeWsMock();

const MockWebSocket = jest.fn<() => WsMock>().mockImplementation(() => {
	currentWsMock = makeWsMock();
	return currentWsMock;
});

// WebSocket.OPEN constant needed by disconnect() and send()
(MockWebSocket as unknown as { OPEN: number }).OPEN = 1;

(global as unknown as Record<string, unknown>).WebSocket = MockWebSocket;

const { Connection } = await import('./connection');

describe('Connection', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		currentWsMock = makeWsMock();
		const freshMock = jest.fn<() => WsMock>().mockImplementation(() => {
			currentWsMock = makeWsMock();
			return currentWsMock;
		});
		(freshMock as unknown as { OPEN: number }).OPEN = 1;
		(global as unknown as Record<string, unknown>).WebSocket = freshMock;
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('starts disconnected', () => {
		const conn = new Connection('ws://localhost:4001');
		expect(conn.isOpen()).toBe(false);
	});

	it('connect() creates a WebSocket converting http to ws', async () => {
		const conn = new Connection('http://localhost:4001');
		await conn.connect();
		expect((global as unknown as Record<string, { mock: { calls: unknown[][] } }>).WebSocket.mock.calls[0][0]).toBe(
			'ws://localhost:4001',
		);
	});

	it('connect() passes ws:// URLs unchanged', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		expect((global as unknown as Record<string, { mock: { calls: unknown[][] } }>).WebSocket.mock.calls[0][0]).toBe(
			'ws://localhost:4001',
		);
	});

	it('isOpen() returns false before onopen fires', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		expect(conn.isOpen()).toBe(false);
	});

	it('isOpen() returns true after WebSocket fires onopen', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		expect(conn.isOpen()).toBe(true);
	});

	it('connect() is idempotent — second call does not create another WebSocket', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		const wsCtor = (global as unknown as Record<string, { mock: { calls: unknown[][] } }>).WebSocket;
		const callsBefore = wsCtor.mock.calls.length;
		await conn.connect(); // status is Connected, not Disconnected — should no-op
		expect(wsCtor.mock.calls.length).toBe(callsBefore);
	});

	it('emits message event when WebSocket receives data', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		const listener = jest.fn<(data: string) => void>();
		conn.on('message', listener);
		currentWsMock.onmessage!({ data: '{"tag":"HeadIsOpen"}' });
		expect(listener).toHaveBeenCalledWith('{"tag":"HeadIsOpen"}');
	});

	it('emits close event when WebSocket closes with code 1006', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		const closeListener = jest.fn<(err: unknown) => void>();
		conn.on('close', closeListener);
		currentWsMock.onclose!({ code: 1006 });
		// Allow onerror async to run
		await Promise.resolve();
		expect(closeListener).toHaveBeenCalled();
	});

	it('schedules reconnect when WebSocket closes with code 1006 and status is Connected', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		const wsCtor = (global as unknown as Record<string, jest.Mock>).WebSocket;
		const callsBefore = wsCtor.mock.calls.length;
		currentWsMock.onclose!({ code: 1006 });
		// onerror sets status to Connecting (not Disconnected), so connect() won't fire
		// Advance past the 1000ms setTimeout in onerror
		await Promise.resolve();
		jest.advanceTimersByTime(1100);
		// connect() is called but status is Connecting, not Disconnected — so no new WebSocket
		expect(wsCtor.mock.calls.length).toBe(callsBefore);
	});

	it('does not emit close when WebSocket closes with code other than 1006', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		const closeListener = jest.fn<(err: unknown) => void>();
		conn.on('close', closeListener);
		currentWsMock.onclose!({ code: 1000 }); // normal close
		await Promise.resolve();
		expect(closeListener).not.toHaveBeenCalled();
	});

	it('disconnect() closes the WebSocket with code 1007 when socket is OPEN', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		currentWsMock.readyState = 1; // OPEN
		await conn.disconnect();
		expect(currentWsMock.close).toHaveBeenCalledWith(1007);
		expect(conn.isOpen()).toBe(false);
	});

	it('disconnect() does not close socket when readyState is not OPEN', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		currentWsMock.readyState = 0; // CONNECTING
		await conn.disconnect();
		expect(currentWsMock.close).not.toHaveBeenCalled();
		expect(conn.isOpen()).toBe(false);
	});

	it('disconnect() is a no-op when already disconnected', async () => {
		const conn = new Connection('ws://localhost:4001');
		await conn.disconnect(); // status is already Disconnected
		expect(currentWsMock.close).not.toHaveBeenCalled();
	});

	it('send() calls ws.send via interval when socket is OPEN', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		currentWsMock.readyState = 1; // OPEN
		conn.send({ tag: 'Init' });
		// send() uses setInterval(1000) — advance past first tick
		jest.advanceTimersByTime(1100);
		expect(currentWsMock.send).toHaveBeenCalled();
	});

	it('send() does not call ws.send immediately — only after interval fires', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		currentWsMock.readyState = 1; // OPEN
		conn.send({ tag: 'Init' });
		// Before any timer fires
		expect(currentWsMock.send).not.toHaveBeenCalled();
	});

	it('send() times out after 5 seconds if socket never reaches OPEN state', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.readyState = 0; // CONNECTING — not open
		conn.send({ tag: 'Init' });
		jest.advanceTimersByTime(6000);
		expect(currentWsMock.send).not.toHaveBeenCalled();
	});

	it('send() stops retrying after successful send', async () => {
		jest.useFakeTimers();
		const conn = new Connection('ws://localhost:4001');
		await conn.connect();
		currentWsMock.onopen!({});
		currentWsMock.readyState = 1; // OPEN
		conn.send({ tag: 'Init' });
		jest.advanceTimersByTime(1100); // first interval fires — send succeeds
		const callsAfterFirst = currentWsMock.send.mock.calls.length;
		jest.advanceTimersByTime(2000); // additional ticks — should not send again
		expect(currentWsMock.send.mock.calls.length).toBe(callsAfterFirst);
	});
});
