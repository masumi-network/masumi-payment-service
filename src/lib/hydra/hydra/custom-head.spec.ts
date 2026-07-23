import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraHeadEvent, HydraNodeEvent } from './types';
import type { HydraTransaction, HydraNodeConfig } from './types';
import type { UTxO } from '@meshsdk/core';

// ---------------------------------------------------------------------------
// Mock HydraNode — must be defined before jest.unstable_mockModule
// ---------------------------------------------------------------------------

class MockHydraNode extends EventEmitter {
	connect = jest.fn<() => void>().mockReturnValue(undefined);
	init = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	commit = jest.fn<(utxos: UTxO[], blueprintTx?: string) => Promise<HydraTransaction>>().mockResolvedValue({
		type: 'Tx ConwayEra' as HydraTransaction['type'],
		cborHex: 'deadbeef',
		description: '',
		txId: 'mocktxid',
	});
	close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	fanout = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	newTx = jest.fn<(transaction: HydraTransaction) => Promise<string>>().mockResolvedValue('newtxhash');
	awaitTx = jest.fn<(txHash: string, checkInterval?: number) => Promise<boolean>>().mockResolvedValue(true);
	cardanoTransaction = jest
		.fn<(transaction: HydraTransaction) => Promise<unknown>>()
		.mockResolvedValue({ confirmed: true });
	isTxConfirmed = jest.fn<(txHash: string) => boolean>().mockReturnValue(false);
	snapshotUTxO = jest.fn<() => Promise<UTxO[]>>().mockResolvedValue([]);
	get status() {
		return HydraHeadStatus.Open;
	}
	get httpUrl() {
		return 'http://localhost:4001';
	}
	get wsUrl() {
		return 'ws://localhost:4001';
	}
}

const nodeInstances: MockHydraNode[] = [];

jest.unstable_mockModule('./node', () => ({
	HydraNode: jest.fn<(config: { httpUrl: string }) => MockHydraNode>().mockImplementation(() => {
		const instance = new MockHydraNode();
		nodeInstances.push(instance);
		return instance;
	}),
}));

const { CustomHydraHead } = await import('./custom-head');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const singleConfig: HydraNodeConfig[] = [{ httpUrl: 'http://localhost:4001', walletId: 'wallet-a' }];

const multiConfig: HydraNodeConfig[] = [
	{ httpUrl: 'http://localhost:4001', walletId: 'wallet-a' },
	{ httpUrl: 'http://localhost:4002', walletId: 'wallet-b' },
];

const mockTx: HydraTransaction = {
	type: 'Tx ConwayEra' as HydraTransaction['type'],
	cborHex: 'cafebabe',
	description: 'test tx',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CustomHydraHead', () => {
	beforeEach(() => {
		nodeInstances.length = 0;
		jest.clearAllMocks();
	});

	// -------------------------------------------------------------------------
	// Constructor
	// -------------------------------------------------------------------------

	describe('constructor', () => {
		it('throws when nodeConfigs is empty', () => {
			expect(() => new CustomHydraHead([])).toThrow('No node configs provided');
		});

		it('creates a HydraNode for each config', () => {
			new CustomHydraHead(multiConfig);
			expect(nodeInstances).toHaveLength(2);
		});

		it('creates one HydraNode for a single config', () => {
			new CustomHydraHead(singleConfig);
			expect(nodeInstances).toHaveLength(1);
		});

		it('initialises _connected to false for each wallet', () => {
			const head = new CustomHydraHead(multiConfig);
			expect(head.connected('wallet-a')).toBe(false);
			expect(head.connected('wallet-b')).toBe(false);
		});

		it('exposes the first walletId as mainNodeName', () => {
			const head = new CustomHydraHead(multiConfig);
			expect(head.mainNodeName).toBe('wallet-a');
		});

		it('exposes the node instance for each walletId', () => {
			const head = new CustomHydraHead(multiConfig);
			expect(head.getHydraNode('wallet-a')).toBe(nodeInstances[0]);
			expect(head.getHydraNode('wallet-b')).toBe(nodeInstances[1]);
		});

		it('revokes captured heads at every mutating command boundary without blocking connect or reads', async () => {
			const isMutationAllowed = jest.fn(() => false);
			const head = new CustomHydraHead(singleConfig, { isMutationAllowed });

			await head.connect('wallet-a');
			await expect(head.awaitTx('read-only')).resolves.toBe(true);
			await expect(head.init()).rejects.toThrow('no longer admitted');
			await expect(head.commit([], null, null)).rejects.toThrow('no longer admitted');
			await expect(head.close()).rejects.toThrow('no longer admitted');
			await expect(head.fanout()).rejects.toThrow('no longer admitted');
			await expect(head.cardanoTransaction(mockTx, null)).rejects.toThrow('no longer admitted');
			await expect(head.newTx(mockTx, null)).rejects.toThrow('no longer admitted');

			expect(nodeInstances[0].connect).toHaveBeenCalledTimes(1);
			expect(nodeInstances[0].awaitTx).toHaveBeenCalledTimes(1);
			expect(nodeInstances[0].init).not.toHaveBeenCalled();
			expect(nodeInstances[0].commit).not.toHaveBeenCalled();
			expect(nodeInstances[0].close).not.toHaveBeenCalled();
			expect(nodeInstances[0].fanout).not.toHaveBeenCalled();
			expect(nodeInstances[0].cardanoTransaction).not.toHaveBeenCalled();
			expect(nodeInstances[0].newTx).not.toHaveBeenCalled();
			expect(isMutationAllowed).toHaveBeenCalledTimes(6);
		});
	});

	// -------------------------------------------------------------------------
	// mainNode / mainNodeConnected
	// -------------------------------------------------------------------------

	describe('mainNode', () => {
		it('returns the node corresponding to the first walletId', () => {
			const head = new CustomHydraHead(multiConfig);
			expect(head.mainNode).toBe(nodeInstances[0]);
		});

		it('mainNodeConnected is false before connect() is called', () => {
			const head = new CustomHydraHead(singleConfig);
			expect(head.mainNodeConnected).toBe(false);
		});

		it('mainNodeConnected is true after connect() succeeds', async () => {
			const head = new CustomHydraHead(singleConfig);
			nodeInstances[0].connect.mockReturnValue(undefined);
			await head.connect('wallet-a');
			expect(head.mainNodeConnected).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// connect
	// -------------------------------------------------------------------------

	describe('connect()', () => {
		it('delegates to the node for the given walletId', async () => {
			const head = new CustomHydraHead(multiConfig);
			await head.connect('wallet-b');
			expect(nodeInstances[1].connect).toHaveBeenCalledTimes(1);
		});

		it('marks the wallet as connected after a successful call', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.connect('wallet-a');
			expect(head.connected('wallet-a')).toBe(true);
		});

		it('is idempotent — second call is a no-op', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.connect('wallet-a');
			await head.connect('wallet-a');
			expect(nodeInstances[0].connect).toHaveBeenCalledTimes(1);
		});

		it('marks wallet as disconnected when node.connect throws', async () => {
			const head = new CustomHydraHead(singleConfig);
			nodeInstances[0].connect.mockImplementation(() => {
				throw new Error('connection refused');
			});
			await expect(head.connect('wallet-a')).rejects.toThrow('connection refused');
			expect(head.connected('wallet-a')).toBe(false);
		});

		it('rejects an unknown wallet instead of marking it connected', async () => {
			const head = new CustomHydraHead(singleConfig);
			await expect(head.connect('wallet-missing')).rejects.toThrow('is not configured');
			expect(head.connected('wallet-missing')).toBe(false);
		});
	});

	// -------------------------------------------------------------------------
	// init
	// -------------------------------------------------------------------------

	describe('init()', () => {
		it('throws when the main node is not connected', async () => {
			const head = new CustomHydraHead(singleConfig);
			await expect(head.init()).rejects.toThrow('Main node not connected');
		});

		it('delegates to mainNode.init() when main node is connected', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.connect('wallet-a');
			await head.init();
			expect(nodeInstances[0].init).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------------
	// commit
	// -------------------------------------------------------------------------

	describe('commit()', () => {
		it('delegates to mainNode.commit when no participant is given', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.commit([], null, null);
			expect(nodeInstances[0].commit).toHaveBeenCalledTimes(1);
		});

		it('delegates to the specified participant node', async () => {
			const head = new CustomHydraHead(multiConfig);
			await head.commit([], null, 'wallet-b');
			expect(nodeInstances[1].commit).toHaveBeenCalledTimes(1);
			expect(nodeInstances[0].commit).not.toHaveBeenCalled();
		});

		it('throws when the participant walletId does not exist', async () => {
			const head = new CustomHydraHead(singleConfig);
			await expect(head.commit([], null, 'nonexistent')).rejects.toThrow('nonexistent not found in node');
		});

		it('returns the HydraTransaction from the node', async () => {
			const head = new CustomHydraHead(singleConfig);
			const result = await head.commit([], null, null);
			expect(result).toMatchObject({ cborHex: 'deadbeef' });
		});
	});

	// -------------------------------------------------------------------------
	// close / fanout
	// -------------------------------------------------------------------------

	describe('close()', () => {
		it('delegates to mainNode.close()', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.close();
			expect(nodeInstances[0].close).toHaveBeenCalledTimes(1);
		});
	});

	describe('fanout()', () => {
		it('delegates to mainNode.fanout()', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.fanout();
			expect(nodeInstances[0].fanout).toHaveBeenCalledTimes(1);
		});
	});

	// -------------------------------------------------------------------------
	// newTx
	// -------------------------------------------------------------------------

	describe('newTx()', () => {
		it('delegates to mainNode when no participant is given', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.newTx(mockTx, null);
			expect(nodeInstances[0].newTx).toHaveBeenCalledWith(mockTx);
		});

		it('delegates to the specified participant node', async () => {
			const head = new CustomHydraHead(multiConfig);
			await head.newTx(mockTx, 'wallet-b');
			expect(nodeInstances[1].newTx).toHaveBeenCalledWith(mockTx);
			expect(nodeInstances[0].newTx).not.toHaveBeenCalled();
		});

		it('throws when the participant walletId does not exist', async () => {
			const head = new CustomHydraHead(singleConfig);
			await expect(head.newTx(mockTx, 'nonexistent')).rejects.toThrow('nonexistent not found');
		});

		it('returns the tx hash from the node', async () => {
			const head = new CustomHydraHead(singleConfig);
			const result = await head.newTx(mockTx, null);
			expect(result).toBe('newtxhash');
		});
	});

	// -------------------------------------------------------------------------
	// awaitTx
	// -------------------------------------------------------------------------

	describe('awaitTx()', () => {
		it('delegates to mainNode when no participant is given', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.awaitTx('somehash', null);
			expect(nodeInstances[0].awaitTx).toHaveBeenCalledWith('somehash');
		});

		it('delegates to the specified participant node', async () => {
			const head = new CustomHydraHead(multiConfig);
			await head.awaitTx('somehash', 'wallet-b');
			expect(nodeInstances[1].awaitTx).toHaveBeenCalledWith('somehash');
			expect(nodeInstances[0].awaitTx).not.toHaveBeenCalled();
		});

		it('throws when the participant walletId does not exist', async () => {
			const head = new CustomHydraHead(singleConfig);
			await expect(head.awaitTx('somehash', 'nonexistent')).rejects.toThrow('nonexistent not found');
		});

		it('returns the boolean result from the node', async () => {
			const head = new CustomHydraHead(singleConfig);
			const result = await head.awaitTx('somehash', null);
			expect(result).toBe(true);
		});
	});

	// -------------------------------------------------------------------------
	// cardanoTransaction
	// -------------------------------------------------------------------------

	describe('cardanoTransaction()', () => {
		it('delegates to mainNode when no participant is given', async () => {
			const head = new CustomHydraHead(singleConfig);
			await head.cardanoTransaction(mockTx, null);
			expect(nodeInstances[0].cardanoTransaction).toHaveBeenCalledWith(mockTx);
		});

		it('delegates to the specified participant node', async () => {
			const head = new CustomHydraHead(multiConfig);
			await head.cardanoTransaction(mockTx, 'wallet-b');
			expect(nodeInstances[1].cardanoTransaction).toHaveBeenCalledWith(mockTx);
			expect(nodeInstances[0].cardanoTransaction).not.toHaveBeenCalled();
		});

		it('throws when the participant walletId does not exist', async () => {
			const head = new CustomHydraHead(singleConfig);
			await expect(head.cardanoTransaction(mockTx, 'nonexistent')).rejects.toThrow('nonexistent not found');
		});
	});

	// -------------------------------------------------------------------------
	// StatusChange event forwarding
	// -------------------------------------------------------------------------

	describe('StatusChange event forwarding', () => {
		it('forwards StatusChange from mainNode to head listeners', () => {
			const head = new CustomHydraHead(singleConfig);
			const listener = jest.fn<(data: unknown) => void>();
			head.on(HydraHeadEvent.StatusChange, listener);

			const statusData = { status: HydraHeadStatus.Open };
			nodeInstances[0].emit(HydraNodeEvent.StatusChange, statusData);

			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener).toHaveBeenCalledWith(statusData);
		});

		it('updates internal _status when StatusChange fires', () => {
			const head = new CustomHydraHead(singleConfig);
			expect(head.status).toBeNull();

			const statusData = { status: HydraHeadStatus.Open };
			nodeInstances[0].emit(HydraNodeEvent.StatusChange, statusData);

			expect(head.status).toBe(HydraHeadStatus.Open);
		});

		it('updates _status across multiple StatusChange events', () => {
			const head = new CustomHydraHead(singleConfig);

			nodeInstances[0].emit(HydraNodeEvent.StatusChange, { status: HydraHeadStatus.Initializing });
			expect(head.status).toBe(HydraHeadStatus.Initializing);

			nodeInstances[0].emit(HydraNodeEvent.StatusChange, { status: HydraHeadStatus.Open });
			expect(head.status).toBe(HydraHeadStatus.Open);

			nodeInstances[0].emit(HydraNodeEvent.StatusChange, { status: HydraHeadStatus.Closed });
			expect(head.status).toBe(HydraHeadStatus.Closed);
		});

		it('does not forward StatusChange events from non-main nodes', () => {
			const head = new CustomHydraHead(multiConfig);
			const listener = jest.fn<(data: unknown) => void>();
			head.on(HydraHeadEvent.StatusChange, listener);

			// Emit from secondary node (index 1 = wallet-b)
			nodeInstances[1].emit(HydraNodeEvent.StatusChange, { status: HydraHeadStatus.Open });

			expect(listener).not.toHaveBeenCalled();
		});

		it('passes full StatusChangeData including optional fields', () => {
			const head = new CustomHydraHead(singleConfig);
			const listener = jest.fn<(data: unknown) => void>();
			head.on(HydraHeadEvent.StatusChange, listener);

			const fullStatusData = {
				status: HydraHeadStatus.Closed,
				headId: 'head-123',
				snapshotNumber: 42,
				contestationDeadline: '2026-01-01T00:00:00Z',
			};
			nodeInstances[0].emit(HydraNodeEvent.StatusChange, fullStatusData);

			expect(listener).toHaveBeenCalledWith(fullStatusData);
		});
	});

	// -------------------------------------------------------------------------
	// status getter
	// -------------------------------------------------------------------------

	describe('status getter', () => {
		it('returns null initially', () => {
			const head = new CustomHydraHead(singleConfig);
			expect(head.status).toBeNull();
		});

		it('returns the last emitted status after a StatusChange event', () => {
			const head = new CustomHydraHead(singleConfig);
			nodeInstances[0].emit(HydraNodeEvent.StatusChange, { status: HydraHeadStatus.FanoutPossible });
			expect(head.status).toBe(HydraHeadStatus.FanoutPossible);
		});
	});
});
