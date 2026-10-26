import { beforeEach, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraNodeEvent } from '@/lib/hydra/hydra/types';
import type { DecommitSettledData } from '@/lib/hydra/hydra/types';

// Only network and database boundaries are faked. The real node, replay,
// bounded buffer, settlement writer and independent L1 verifier run together.
class TestConnection extends EventEmitter {
	openCount = 0;
	onRestart: () => void = () => undefined;
	connect = jest.fn(async () => {
		this.openCount += 1;
	});
	waitUntilOpen = jest.fn(async () => {
		await this.connect();
	});
	disconnect = jest.fn(async () => undefined);
	isOpen = () => true;
	pauseReceiving = () => undefined;
	resumeReceiving = () => undefined;
	invalidate = jest.fn();
	restart = jest.fn(() => {
		this.emit('close');
		this.openCount += 1;
		queueMicrotask(() => this.onRestart());
	});
}
const connections: TestConnection[] = [];
jest.unstable_mockModule('@/lib/hydra/hydra/connection', () => ({
	Connection: class extends TestConnection {
		constructor() {
			super();
			connections.push(this);
		}
	},
}));

const fixture = JSON.parse(readFileSync(new URL('./real-mainnet-decrement.fixture.json', import.meta.url), 'utf8')) as {
	txHash: string;
	blockTime: number;
	headId: string;
	payoutAddress: string;
	payoutLovelace: string;
	cbor: string;
	utxos: object;
};
const OWN_ID = 'aa'.repeat(32);
const PEER_LOVELACE = 7_000_000n;
const LATER_PEER_WITHDRAWALS = 16;
const FINAL_SNAPSHOT_NUMBER = 7;
const approvedAt = new Date((fixture.blockTime - 60) * 1000);
const finalizedAt = new Date(fixture.blockTime * 1000);
const peerFinalizedAt = new Date((fixture.blockTime + 60) * 1000);
let row: any;

// A stateful database boundary is needed here: a peer finalization must not
// poison the row read by the later production reconciliation pass.
function matches(value: any, condition: any): boolean {
	return Object.entries(condition).every(([key, expected]: [string, any]) => {
		if (key === 'AND') return expected.every((part: any) => matches(value, part));
		if (key === 'OR') return expected.some((part: any) => matches(value, part));
		if (expected === null || typeof expected !== 'object' || expected instanceof Date) return value[key] === expected;
		return Object.entries(expected).every(([operator, operand]: [string, any]) => {
			if (operator === 'equals') return JSON.stringify(value[key]) === JSON.stringify(operand);
			if (operator === 'in') return operand.includes(value[key]);
			if (operator === 'not') return value[key] !== operand;
			if (operator === 'lte') return value[key] !== null && value[key] <= operand;
			if (operator === 'gt') return value[key] !== null && value[key] > operand;
			if (operator === 'gte') return value[key] !== null && value[key] >= operand;
			return false;
		});
	});
}
const database = {
	hydraDecommit: {
		updateMany: jest.fn(async ({ where, data }: any) => {
			if (!matches(row, where)) return { count: 0 };
			Object.assign(row, data);
			return { count: 1 };
		}),
		findMany: jest.fn(async ({ where }: any) => (matches(row, where) ? [structuredClone(row)] : [])),
		findUnique: jest.fn(async () => structuredClone(row)),
		update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
	},
};
const observer = {
	addressesTransactions: jest.fn(async (_address: string, { page }: { page: number }) =>
		page === 1 ? [{ tx_hash: fixture.txHash, block_time: fixture.blockTime }] : [],
	),
	txsUtxos: jest.fn(async () => fixture.utxos),
	txsCbor: jest.fn(async () => ({ cbor: fixture.cbor })),
	txs: jest.fn(async () => ({ hash: fixture.txHash, valid_contract: true, block: 'fixture-block' })),
	blocks: jest.fn(async () => ({ confirmations: 100 })),
};
jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: database }));
jest.unstable_mockModule('@/utils/blockfrost', () => ({ getBlockfrostInstance: () => observer }));
const { HydraNode } = await import('@/lib/hydra/hydra/node');
const { historyReplayYieldSettings } = await import('@/lib/hydra/hydra/node-history-frame-queue');
const { applyDecommitOutcome } = await import('./settle');
const { reconcileUnidentifiedDecommitPayouts, resolveDecommitPayoutTx } = await import('./payout-lookup');

beforeEach(() => {
	jest.clearAllMocks();
	connections.length = 0;
	row = {
		id: 'own-withdrawal',
		hydraHeadId: 'head-db-id',
		decommitTxId: OWN_ID,
		status: 'Approved',
		approvedAt,
		createdAt: approvedAt,
		updatedAt: approvedAt,
		l1ObservedAt: null,
		settledLovelace: null,
		settledAssets: null,
		l1TxId: null,
		l1CheckedAt: null,
		destinationAddress: fixture.payoutAddress,
		HydraHead: { headIdentifier: fixture.headId },
		LocalParticipant: {
			Wallet: {
				PaymentSource: {
					network: 'Mainnet',
					PaymentSourceConfig: { rpcProviderApiKey: 'fixture-key' },
				},
			},
		},
	};
	// Socket frames are deterministic here; queue scheduling has its own tests.
	historyReplayYieldSettings.budgetMs = Number.POSITIVE_INFINITY;
});

function withdrawalFrames(txId: string, lovelace: bigint, timestamp: Date): string[] {
	return [
		JSON.stringify({
			tag: 'DecommitApproved',
			headId: fixture.headId,
			decommitTxId: txId,
			timestamp: timestamp.toISOString(),
		}),
		JSON.stringify({
			tag: 'DecommitFinalized',
			headId: fixture.headId,
			timestamp: timestamp.toISOString(),
			// Pinned Hydra uses L1 input references here, not the in-head decommit id.
			distributedUTxO: {
				[`${'ff'.repeat(32)}#0`]: { address: fixture.payoutAddress, value: { lovelace: String(lovelace) } },
			},
		}),
	];
}

it.each([HydraHeadStatus.Open, HydraHeadStatus.Final])(
	'recovers an old local finalization after the bounded buffer overflows (%s)',
	async (status) => {
		const node = new HydraNode({
			httpUrl: 'http://localhost:4001',
			expectedHeadId: fixture.headId,
			trustLocalNodeSnapshotMetadata: true,
		});
		const statusChanges: Array<{ status: HydraHeadStatus; snapshotNumber?: number }> = [];
		node.on(HydraNodeEvent.StatusChange, (data) => statusChanges.push(data));
		const pending: Array<Promise<boolean>> = [];
		node.on(HydraNodeEvent.DecommitSettled, (data: DecommitSettledData) => {
			pending.push(applyDecommitOutcome({ ...data, hydraHeadId: row.hydraHeadId }));
		});
		const connected = node.connect();
		const [history, live] = connections;
		const frames = [
			JSON.stringify({ tag: 'HeadIsOpen', headId: fixture.headId, utxo: {} }),
			...withdrawalFrames(OWN_ID, BigInt(fixture.payoutLovelace), finalizedAt),
		];
		for (let index = 0; index < LATER_PEER_WITHDRAWALS; index += 1) {
			frames.push(...withdrawalFrames(index.toString(16).padStart(64, '0'), PEER_LOVELACE, peerFinalizedAt));
		}
		if (status === HydraHeadStatus.Final) {
			frames.push(
				JSON.stringify({ tag: 'HeadIsClosed', headId: fixture.headId, snapshotNumber: FINAL_SNAPSHOT_NUMBER }),
				JSON.stringify({ tag: 'HeadIsFinalized', headId: fixture.headId, finalizedUTxO: {} }),
			);
		}
		frames.push(
			JSON.stringify(
				status === HydraHeadStatus.Final
					? { tag: 'Greetings', headStatus: 'Idle' }
					: { tag: 'Greetings', headStatus: 'Open', headId: fixture.headId },
			),
		);
		const replay = () => {
			for (const frame of frames) history.emit('message', frame);
		};
		if (status === HydraHeadStatus.Final) {
			live.emit('message', JSON.stringify({ tag: 'Greetings', headStatus: 'Idle' }));
			// Finish the fresh pass requested by the held Idle before enabling auto replay.
			await Promise.resolve();
		}
		history.onRestart = replay;
		for (const frame of frames.slice(0, -1)) history.emit('message', frame);
		expect(pending).toHaveLength(0);
		history.emit('message', frames[frames.length - 1]);
		if (status === HydraHeadStatus.Open)
			live.emit('message', JSON.stringify({ tag: 'Greetings', headStatus: 'Open', headId: fixture.headId }));
		// Overflow still retains at most 32 outcomes before the recovery pass.
		expect(pending).toHaveLength(32);
		await connected;
		await Promise.resolve();
		await Promise.all(pending);
		await new Promise((resolve) => setImmediate(resolve));
		await reconcileUnidentifiedDecommitPayouts();

		expect(history.restart).toHaveBeenCalledTimes(status === HydraHeadStatus.Final ? 2 : 1);
		if (status === HydraHeadStatus.Final)
			expect(statusChanges).toContainEqual(expect.objectContaining({ status, snapshotNumber: FINAL_SNAPSHOT_NUMBER }));
		expect(row.status).toBe('Finalized');
		expect(row.settledLovelace).toBe(BigInt(fixture.payoutLovelace));
		expect(row.l1TxId).toBe(fixture.txHash);
		await node.disconnect();
	},
);

it('repairs a poisoned Approved row only from the exact named local finalization and independent L1 proof', async () => {
	row.l1ObservedAt = peerFinalizedAt;
	row.settledLovelace = PEER_LOVELACE;
	row.settledAssets = {};
	await applyDecommitOutcome({
		hydraHeadId: row.hydraHeadId,
		decommitTxId: OWN_ID,
		outcome: 'finalized',
		observedAt: finalizedAt,
		distributed: { lovelace: BigInt(fixture.payoutLovelace), assets: {} },
	});
	await new Promise((resolve) => setImmediate(resolve));
	await reconcileUnidentifiedDecommitPayouts();
	expect(row.settledLovelace).toBe(BigInt(fixture.payoutLovelace));
	expect(row.status).toBe('Finalized');
	expect(row.l1TxId).toBe(fixture.txHash);
});

it.each(['history', 'live'])('does not reuse an approval from a closed %s socket', async (stream) => {
	const node = new HydraNode({
		httpUrl: 'http://localhost:4001',
		expectedHeadId: fixture.headId,
		trustLocalNodeSnapshotMetadata: true,
	});
	const pending: Array<Promise<boolean>> = [];
	node.on(HydraNodeEvent.DecommitSettled, (data: DecommitSettledData) => {
		pending.push(applyDecommitOutcome({ ...data, hydraHeadId: row.hydraHeadId }));
	});
	const connected = node.connect();
	const [history, live] = connections;
	const greeting = JSON.stringify({ tag: 'Greetings', headStatus: 'Open', headId: fixture.headId });
	live.emit('message', greeting);
	await connected;
	const connection = stream === 'history' ? history : live;
	const [approval, finalization] = withdrawalFrames(OWN_ID, BigInt(fixture.payoutLovelace), finalizedAt);
	connection.emit('message', approval);
	connection.emit('close');
	live.emit('message', greeting);
	connection.emit('message', finalization);
	await Promise.all(pending);
	expect(row.l1ObservedAt).toBeNull();
	expect(row.settledLovelace).toBeNull();
	await node.disconnect();
});

it('does not demote a payout finalized between the settlement read and write', async () => {
	row.l1ObservedAt = finalizedAt;
	row.settledLovelace = BigInt(fixture.payoutLovelace);
	row.settledAssets = {};
	database.hydraDecommit.findMany.mockImplementationOnce(async () => {
		const observed = structuredClone(row);
		row.status = 'Finalized';
		row.l1TxId = fixture.txHash;
		return [observed];
	});
	expect(
		await applyDecommitOutcome({
			hydraHeadId: row.hydraHeadId,
			decommitTxId: OWN_ID,
			outcome: 'finalized',
			observedAt: peerFinalizedAt,
			distributed: { lovelace: PEER_LOVELACE, assets: {} },
		}),
	).toBe(false);
	expect(row.status).toBe('Finalized');
	expect(row.settledLovelace).toBe(BigInt(fixture.payoutLovelace));
	expect(row.l1TxId).toBe(fixture.txHash);
});

it.each(['lovelace', 'assets'])(
	'does not promote a stale proof after replay changes the observed %s',
	async (changed) => {
		row.l1ObservedAt = finalizedAt;
		row.settledLovelace = BigInt(fixture.payoutLovelace);
		row.settledAssets = {};
		let releaseDepth!: () => void;
		const depthGate = new Promise<void>((resolve) => {
			releaseDepth = resolve;
		});
		let reachedDepth!: () => void;
		const depthPending = new Promise<void>((resolve) => {
			reachedDepth = resolve;
		});
		observer.blocks.mockImplementationOnce(async () => {
			reachedDepth();
			await depthGate;
			return { confirmations: 100 };
		});
		const lookup = resolveDecommitPayoutTx({
			decommitId: row.id,
			distributed: { lovelace: BigInt(fixture.payoutLovelace), assets: {} },
		});
		await depthPending;
		await applyDecommitOutcome({
			hydraHeadId: row.hydraHeadId,
			decommitTxId: OWN_ID,
			outcome: 'finalized',
			observedAt: peerFinalizedAt,
			distributed:
				changed === 'lovelace'
					? { lovelace: PEER_LOVELACE, assets: {} }
					: { lovelace: BigInt(fixture.payoutLovelace), assets: { [`${'ab'.repeat(28)}01`]: '1' } },
		});
		releaseDepth();
		await lookup;
		await new Promise((resolve) => setImmediate(resolve));
		expect(row.status).toBe('Approved');
		expect(row.finalizedAt).toBeUndefined();
		await applyDecommitOutcome({
			hydraHeadId: row.hydraHeadId,
			decommitTxId: OWN_ID,
			outcome: 'finalized',
			observedAt: finalizedAt,
			distributed: { lovelace: BigInt(fixture.payoutLovelace), assets: {} },
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(row.status).toBe('Finalized');
		expect(row.settledLovelace).toBe(BigInt(fixture.payoutLovelace));
		expect(row.settledAssets).toEqual({});
	},
);
