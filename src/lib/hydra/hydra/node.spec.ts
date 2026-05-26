import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraNodeEvent } from './types';

// MockConnection must be defined before jest.unstable_mockModule
class MockConnection extends EventEmitter {
	connect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	disconnect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	send = jest.fn<(data: unknown) => void>();
	isOpen = jest.fn<() => boolean>().mockReturnValue(false);
}

let mockConnectionInstance: MockConnection;

jest.unstable_mockModule('./connection', () => ({
	Connection: jest.fn<() => MockConnection>().mockImplementation(() => {
		mockConnectionInstance = new MockConnection();
		return mockConnectionInstance;
	}),
}));

const mockFetch = jest.fn<typeof fetch>();
(global as unknown as Record<string, unknown>).fetch = mockFetch;

// Import AFTER mock setup
const { HydraNode } = await import('./node');

describe('HydraNode', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	// Helper to flush microtask queue
	const flushMicrotasks = async () => {
		await new Promise((resolve) => setImmediate(resolve));
	};

	describe('constructor and getters', () => {
		it('derives wsUrl from http httpUrl', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			expect(node.wsUrl).toBe('ws://localhost:4001');
		});

		it('derives wssUrl from https httpUrl', () => {
			const node = new HydraNode({ httpUrl: 'https://example.com' });
			expect(node.wsUrl).toBe('wss://example.com');
		});

		it('uses explicit wsUrl when provided', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', wsUrl: 'ws://custom:5001' });
			expect(node.wsUrl).toBe('ws://custom:5001');
		});

		it('exposes httpUrl getter', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			expect(node.httpUrl).toBe('http://localhost:4001');
		});

		it('starts with Disconnected status', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			expect(node.status).toBe(HydraHeadStatus.Disconnected);
		});
	});

	describe('connect()', () => {
		it('registers message listeners and calls connection.connect', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
		});

		it('does not reconnect when already not Disconnected after first connect', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			// Emit HeadIsOpen so status changes away from Disconnected
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen' }));
			expect(node.status).toBe(HydraHeadStatus.Open);

			node.connect(); // second call — status is now Open, not Disconnected
			// connect() was only called once on the mock
			expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
		});
	});

	describe('status change processing', () => {
		it('emits StatusChange with Open when HeadIsOpen received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statusChanges: Array<{ status: HydraHeadStatus }> = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statusChanges.push(data as { status: HydraHeadStatus }));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen' }));

			expect(statusChanges).toHaveLength(1);
			expect(statusChanges[0].status).toBe(HydraHeadStatus.Open);
			expect(node.status).toBe(HydraHeadStatus.Open);
		});

		it('emits StatusChange with Initializing when HeadIsInitializing received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsInitializing' }));

			expect(statuses).toEqual([HydraHeadStatus.Initializing]);
		});

		it('emits StatusChange with Closed when HeadIsClosed received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsClosed' }));

			expect(statuses).toEqual([HydraHeadStatus.Closed]);
		});

		it('emits StatusChange with FanoutPossible when ReadyToFanout received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'ReadyToFanout' }));

			expect(statuses).toEqual([HydraHeadStatus.FanoutPossible]);
		});

		it('emits StatusChange with Final when HeadIsFinalized received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsFinalized' }));

			expect(statuses).toEqual([HydraHeadStatus.Final]);
		});

		it('emits StatusChange with status from headStatus field on Greetings', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'Greetings', headStatus: 'Open' }));

			expect(statuses).toEqual([HydraHeadStatus.Open]);
		});

		it('does not emit StatusChange when Greetings has invalid headStatus', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'Greetings', headStatus: 'InvalidStatus' }));

			expect(statuses).toHaveLength(0);
		});

		it('does not emit StatusChange for the same status twice (deduplication)', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen' }));
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen' }));

			expect(statuses).toHaveLength(1);
		});

		it('emits StatusChange again when status transitions to a different value', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen' }));
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsClosed' }));

			expect(statuses).toEqual([HydraHeadStatus.Open, HydraHeadStatus.Closed]);
		});

		it('does not emit StatusChange for unknown tags without headStatus', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			// TxValid has no status mapping and won't trigger processConfirmedTx
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'TxValid' }));

			expect(statuses).toHaveLength(0);
		});

		it('includes headId in StatusChange data when present', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const changes: Array<{ status: HydraHeadStatus; headId?: string }> = [];
			node.on(HydraNodeEvent.StatusChange, (data) =>
				changes.push(data as { status: HydraHeadStatus; headId?: string }),
			);

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: 'abc123' }));

			expect(changes[0].headId).toBe('abc123');
		});

		it('includes contestationDeadline in status change data when HeadIsClosed message includes it', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const changes: unknown[] = [];
			node.on(HydraNodeEvent.StatusChange, (d) => changes.push(d));

			mockConnectionInstance.emit(
				'message',
				JSON.stringify({
					tag: 'HeadIsClosed',
					contestationDeadline: '2026-06-01T00:00:00Z',
				}),
			);

			expect((changes[0] as { contestationDeadline: string }).contestationDeadline).toBe('2026-06-01T00:00:00Z');
		});
	});

	describe('SnapshotConfirmed processing', () => {
		it('adds txIds to buffer and emits TxConfirmed after SnapshotConfirmed', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const confirmedTxs: string[] = [];
			node.on(HydraNodeEvent.TxConfirmed, (txId) => confirmedTxs.push(txId as string));

			const snapshotMessage = JSON.stringify({
				tag: 'SnapshotConfirmed',
				snapshot: {
					snapshotNumber: 1,
					confirmed: [
						{ type: 'Tx ConwayEra', cborHex: 'abc', description: 'tx1', txId: 'txhash001' },
						{ type: 'Tx ConwayEra', cborHex: 'def', description: 'tx2', txId: 'txhash002' },
					],
				},
			});

			mockConnectionInstance.emit('message', snapshotMessage);
			await flushMicrotasks();

			expect(confirmedTxs).toEqual(['txhash001', 'txhash002']);
		});

		it('makes isTxConfirmed return true after SnapshotConfirmed', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			expect(node.isTxConfirmed('txhash-xyz')).toBe(false);

			const snapshotMessage = JSON.stringify({
				tag: 'SnapshotConfirmed',
				snapshot: {
					confirmed: [{ type: 'Tx ConwayEra', cborHex: 'abc', description: '', txId: 'txhash-xyz' }],
				},
			});

			mockConnectionInstance.emit('message', snapshotMessage);
			await flushMicrotasks();

			expect(node.isTxConfirmed('txhash-xyz')).toBe(true);
		});
	});

	describe('isTxConfirmed()', () => {
		it('returns false for an unknown txHash', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			expect(node.isTxConfirmed('nonexistent-hash')).toBe(false);
		});
	});

	describe('awaitTx()', () => {
		it('resolves true when tx is already confirmed in buffer', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			// First confirm the tx via SnapshotConfirmed
			const snapshotMessage = JSON.stringify({
				tag: 'SnapshotConfirmed',
				snapshot: {
					confirmed: [{ type: 'Tx ConwayEra', cborHex: 'abc', description: '', txId: 'pre-confirmed-hash' }],
				},
			});
			mockConnectionInstance.emit('message', snapshotMessage);
			await flushMicrotasks();

			// Now awaitTx should resolve on the next interval tick
			jest.useFakeTimers();
			const resultPromise = node.awaitTx('pre-confirmed-hash', 100);
			jest.advanceTimersByTime(100);
			jest.useRealTimers();

			const result = await resultPromise;
			expect(result).toBe(true);
		});
	});

	describe('HTTP methods', () => {
		it('get() calls fetch with GET and correct URL', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			mockFetch.mockResolvedValue({
				json: async () => ({ key: 'value' }),
			} as Response);

			const result = await node.get('/snapshot/utxo');

			expect(mockFetch).toHaveBeenCalledWith('http://localhost:4001/snapshot/utxo', {
				method: 'GET',
				headers: { 'Content-Type': 'application/json' },
			});
			expect(result).toEqual({ key: 'value' });
		});

		it('post() calls fetch with POST, correct URL, and serialized body', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			const payload = { tag: 'test', data: 42 };

			mockFetch.mockResolvedValue({
				json: async () => ({ submitted: true }),
			} as Response);

			const result = await node.post('/commit', payload);

			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:4001/commit',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
				}),
			);
			expect(result).toEqual({ submitted: true });
		});

		it('get() throws when fetch response is not valid JSON', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			const syntaxError = new SyntaxError('Unexpected token');
			mockFetch.mockResolvedValue({
				json: async () => {
					throw syntaxError;
				},
				text: async () => 'Internal Server Error',
			} as unknown as Response);

			await expect(node.get('/bad-endpoint')).rejects.toThrow('Internal Server Error');
		});

		it('post() propagates non-SyntaxError fetch failures', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			const networkError = new Error('Network failure');

			mockFetch.mockResolvedValue({
				json: async () => {
					throw networkError;
				},
			} as unknown as Response);

			await expect(node.post('/commit', {})).rejects.toThrow('Network failure');
		});
	});
});
