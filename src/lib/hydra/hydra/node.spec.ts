import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { createPrivateKey, createPublicKey, sign as signEd25519, type KeyObject } from 'node:crypto';
import { resolveTxHash } from '@meshsdk/core';
import {
	Address,
	BigNum,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraNodeEvent, HydraTransactionType } from './types';
import { HydraProtocolError, HydraTransactionRejectedError, HydraTransportAmbiguousError } from './errors';
import {
	computeHydraAccumulatorHash,
	hydraSnapshotSignableBytes,
	serializeHydraSnapshotOutput,
	type HydraSnapshotVerificationFrame,
} from './snapshot-verification';

// MockConnection must be defined before jest.unstable_mockModule
class MockConnection extends EventEmitter {
	connect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	waitUntilOpen = jest.fn(async () => {
		await this.connect();
	});
	disconnect = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
	send = jest.fn<(data: unknown) => Promise<void>>().mockResolvedValue(undefined);
	isOpen = jest.fn<() => boolean>().mockReturnValue(false);
	invalidate = jest.fn<(error: Error) => void>();
}

let mockConnectionInstance: MockConnection;
const mockConnectionInstances: MockConnection[] = [];
const mockConnectionUrls: string[] = [];
const mockLoggerError = jest.fn();

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { error: mockLoggerError },
}));

jest.unstable_mockModule('./connection', () => ({
	Connection: jest.fn<(url: string) => MockConnection>().mockImplementation((url) => {
		mockConnectionInstance = new MockConnection();
		mockConnectionInstances.push(mockConnectionInstance);
		mockConnectionUrls.push(url);
		return mockConnectionInstance;
	}),
}));

const mockFetch = jest.fn<typeof fetch>();
(global as unknown as Record<string, unknown>).fetch = mockFetch;

// Import AFTER mock setup
const { HydraNode } = await import('./node');

function makeHydraTransaction(seed: number, description = '') {
	const body = TransactionBody.new(
		TransactionInputs.new(),
		TransactionOutputs.new(),
		BigNum.from_str(String(seed + 1)),
	);
	const transaction = Transaction.new(body, TransactionWitnessSet.new());
	const cborHex = Buffer.from(transaction.to_bytes()).toString('hex');
	return {
		type: HydraTransactionType.TxConwayEra,
		cborHex,
		description,
		txId: String(resolveTxHash(cborHex)).toLowerCase(),
	};
}

const HEAD_ID_A = 'a'.repeat(56);
const HEAD_ID_B = 'b'.repeat(56);
const TEST_ADDRESS =
	'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd';
const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

type TestSnapshotOutput = {
	address: string;
	value: { lovelace: number };
	referenceScript: null;
	datumhash: null;
	inlineDatum: null;
	inlineDatumRaw: null;
	datum: null;
};

type TestSnapshotUtxo = Record<string, TestSnapshotOutput>;

function makeTestParty(seedByte: number): {
	privateKey: KeyObject;
	rawVerificationKey: string;
	cborVerificationKey: string;
} {
	const privateKey = createPrivateKey({
		key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.alloc(32, seedByte)]),
		format: 'der',
		type: 'pkcs8',
	});
	const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
	const rawVerificationKey = Buffer.from(publicKey).subarray(-32).toString('hex');
	return { privateKey, rawVerificationKey, cborVerificationKey: `5820${rawVerificationKey}` };
}

const TEST_PARTIES = [makeTestParty(1), makeTestParty(2)];

function snapshotOutput(lovelace: number): TestSnapshotOutput {
	return {
		address: TEST_ADDRESS,
		value: { lovelace },
		referenceScript: null,
		datumhash: null,
		inlineDatum: null,
		inlineDatumRaw: null,
		datum: null,
	};
}

function makeSpendingHydraTransaction(inputTxHash: string, inputIndex: number, outputLovelace: number) {
	const inputs = TransactionInputs.new();
	inputs.add(TransactionInput.new(TransactionHash.from_bytes(Buffer.from(inputTxHash, 'hex')), inputIndex));
	const outputs = TransactionOutputs.new();
	outputs.add(
		TransactionOutput.new(Address.from_bech32(TEST_ADDRESS), Value.new(BigNum.from_str(String(outputLovelace)))),
	);
	const body = TransactionBody.new_tx_body(inputs, outputs, BigNum.from_str('1000000'));
	const transaction = Transaction.new(body, TransactionWitnessSet.new());
	const cborHex = Buffer.from(transaction.to_bytes()).toString('hex');
	return {
		type: HydraTransactionType.TxConwayEra,
		cborHex,
		description: '',
		txId: String(resolveTxHash(cborHex)).toLowerCase(),
	};
}

function signedSnapshotFrame(options: {
	seq: number;
	number: number;
	utxo: TestSnapshotUtxo;
	confirmed: ReturnType<typeof makeSpendingHydraTransaction>[];
	timestamp?: string;
}) {
	const frame: HydraSnapshotVerificationFrame & {
		tag: 'SnapshotConfirmed';
		seq: number;
		timestamp?: string;
	} = {
		tag: 'SnapshotConfirmed',
		seq: options.seq,
		headId: HEAD_ID_A,
		...(options.timestamp ? { timestamp: options.timestamp } : {}),
		signatures: { multiSignature: [] },
		snapshot: {
			headId: HEAD_ID_A,
			version: 0,
			number: options.number,
			accumulator: computeHydraAccumulatorHash(
				Object.values(options.utxo).map((output) => serializeHydraSnapshotOutput(output)),
			),
			confirmed: options.confirmed,
			utxo: options.utxo,
			utxoToCommit: null,
			utxoToDecommit: null,
		},
	};
	const signableBytes = hydraSnapshotSignableBytes(frame);
	frame.signatures.multiSignature = TEST_PARTIES.map(({ privateKey }) =>
		signEd25519(null, signableBytes, privateKey).toString('hex'),
	);
	return frame;
}

function signedHistoryChain() {
	const initialReference = `${'11'.repeat(32)}#0`;
	const initialUtxo = { [initialReference]: snapshotOutput(10_000_000) };
	const first = makeSpendingHydraTransaction('11'.repeat(32), 0, 9_000_000);
	const second = makeSpendingHydraTransaction(first.txId, 0, 8_000_000);
	const third = makeSpendingHydraTransaction(second.txId, 0, 7_000_000);
	return {
		transactions: [first, second, third],
		frames: [
			signedSnapshotFrame({ seq: 1, number: 1, utxo: initialUtxo, confirmed: [] }),
			signedSnapshotFrame({
				seq: 2,
				number: 2,
				utxo: { [`${second.txId}#0`]: snapshotOutput(8_000_000) },
				confirmed: [first, second],
				timestamp: '2026-07-22T10:00:02Z',
			}),
			signedSnapshotFrame({
				seq: 3,
				number: 3,
				utxo: { [`${third.txId}#0`]: snapshotOutput(7_000_000) },
				confirmed: [third],
				timestamp: '2026-07-22T10:00:03Z',
			}),
		],
	};
}

function signedTwoOutputHistory(options: { duplicateFinalValues?: boolean } = {}) {
	const firstInitialHash = '31'.repeat(32);
	const secondInitialHash = '32'.repeat(32);
	const firstFinalLovelace = 9_000_000;
	const secondFinalLovelace = options.duplicateFinalValues ? firstFinalLovelace : 19_000_000;
	const first = makeSpendingHydraTransaction(firstInitialHash, 0, firstFinalLovelace);
	const second = makeSpendingHydraTransaction(secondInitialHash, 0, secondFinalLovelace);
	const firstFinalOutput = snapshotOutput(firstFinalLovelace);
	const secondFinalOutput = snapshotOutput(secondFinalLovelace);
	return {
		first,
		second,
		firstFinalOutput,
		secondFinalOutput,
		frames: [
			signedSnapshotFrame({
				seq: 1,
				number: 1,
				utxo: {
					[`${firstInitialHash}#0`]: snapshotOutput(10_000_000),
					[`${secondInitialHash}#0`]: snapshotOutput(options.duplicateFinalValues ? 10_000_000 : 20_000_000),
				},
				confirmed: [],
			}),
			signedSnapshotFrame({
				seq: 2,
				number: 2,
				utxo: {
					// Hydra signatures commit only the output multiset. Deliberately
					// equivocate by assigning each unique value to the other producer.
					[`${first.txId}#0`]: secondFinalOutput,
					[`${second.txId}#0`]: firstFinalOutput,
				},
				confirmed: [first, second],
			}),
		],
	};
}

function liveGreetings() {
	return {
		tag: 'Greetings',
		headStatus: 'Open',
		hydraHeadId: HEAD_ID_A,
		me: { vkey: TEST_PARTIES[0].rawVerificationKey },
		env: {
			party: { vkey: TEST_PARTIES[0].rawVerificationKey },
			otherParties: [{ vkey: TEST_PARTIES[1].rawVerificationKey }],
		},
	};
}

function headIsOpen(utxo?: TestSnapshotUtxo) {
	return {
		tag: 'HeadIsOpen',
		headId: HEAD_ID_A,
		parties: TEST_PARTIES.map(({ rawVerificationKey }) => ({ vkey: rawVerificationKey })),
		...(utxo ? { utxo } : {}),
	};
}

async function startSignedNode(overrides: Partial<ConstructorParameters<typeof HydraNode>[0]> = {}): Promise<{
	node: InstanceType<typeof HydraNode>;
	historyConnection: MockConnection;
	liveConnection: MockConnection;
}> {
	const node = new HydraNode({
		httpUrl: 'http://localhost:4001',
		expectedHeadId: HEAD_ID_A,
		snapshotVerificationKeys: TEST_PARTIES.map(({ cborVerificationKey }) => cborVerificationKey),
		expectedNodeVerificationKey: TEST_PARTIES[0].cborVerificationKey,
		trustLocalNodeSnapshotMetadata: true,
		...overrides,
	});
	const connectPromise = node.connect();
	const historyConnection = mockConnectionInstances[0];
	const liveConnection = mockConnectionInstances[1];
	liveConnection.emit('message', JSON.stringify(headIsOpen()));
	liveConnection.emit('message', JSON.stringify(liveGreetings()));
	await connectPromise;
	historyConnection.emit('message', JSON.stringify(headIsOpen()));
	return { node, historyConnection, liveConnection };
}

function finishHistoryReplay(historyConnection: MockConnection): void {
	historyConnection.emit('message', JSON.stringify(liveGreetings()));
}

describe('HydraNode', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockConnectionInstances.length = 0;
		mockConnectionUrls.length = 0;
	});

	afterEach(() => {
		jest.useRealTimers();
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

		it('preserves websocket query params and requests full snapshot UTxO replay', () => {
			new HydraNode({ httpUrl: 'http://localhost:4001', wsUrl: 'ws://custom:5001?foo=bar' });
			expect(mockConnectionUrls).toEqual([
				'ws://custom:5001?foo=bar&history=yes&snapshot-utxo=yes',
				'ws://custom:5001?foo=bar&history=no&snapshot-utxo=yes',
			]);
		});
	});

	describe('connect()', () => {
		it('registers message listeners and calls connection.connect', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
		});

		it('does not attach listeners or start transports twice before Greetings', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			node.connect();
			expect(mockConnectionInstances).toHaveLength(2);
			expect(mockConnectionInstances[0].connect).toHaveBeenCalledTimes(1);
			expect(mockConnectionInstances[1].connect).toHaveBeenCalledTimes(1);
			expect(mockConnectionInstances[0].listenerCount('message')).toBe(1);
			expect(mockConnectionInstances[1].listenerCount('message')).toBe(2);
		});

		it('does not reconnect when already not Disconnected after first connect', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			// Emit HeadIsOpen so status changes away from Disconnected
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));
			expect(node.status).toBe(HydraHeadStatus.Open);

			node.connect(); // second call — status is now Open, not Disconnected
			// connect() was only called once on the mock
			expect(mockConnectionInstance.connect).toHaveBeenCalledTimes(1);
		});

		it('disconnects both live and history transports', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			await node.disconnect();
			expect(mockConnectionInstances[0].disconnect).toHaveBeenCalledTimes(1);
			expect(mockConnectionInstances[1].disconnect).toHaveBeenCalledTimes(1);
			expect(node.status).toBe(HydraHeadStatus.Disconnected);
		});
	});

	describe('status change processing', () => {
		it('emits StatusChange with Open when HeadIsOpen received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statusChanges: Array<{ status: HydraHeadStatus }> = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statusChanges.push(data as { status: HydraHeadStatus }));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));

			expect(statusChanges).toHaveLength(1);
			expect(statusChanges[0].status).toBe(HydraHeadStatus.Open);
			expect(node.status).toBe(HydraHeadStatus.Open);
		});

		it('emits StatusChange with Initializing when HeadIsInitializing received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsInitializing', headId: HEAD_ID_A }));

			expect(statuses).toEqual([HydraHeadStatus.Initializing]);
		});

		it('emits StatusChange with Closed when HeadIsClosed received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsClosed', headId: HEAD_ID_A }));

			expect(statuses).toEqual([HydraHeadStatus.Closed]);
		});

		it('emits StatusChange with FanoutPossible when ReadyToFanout received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'ReadyToFanout', headId: HEAD_ID_A }));

			expect(statuses).toEqual([HydraHeadStatus.FanoutPossible]);
		});

		it('emits StatusChange with Final when HeadIsFinalized received', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsFinalized', headId: HEAD_ID_A }));

			expect(statuses).toEqual([HydraHeadStatus.Final]);
		});

		it('emits StatusChange with status from headStatus field on Greetings', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Greetings', headStatus: 'Open', hydraHeadId: HEAD_ID_A }),
			);

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

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));

			expect(statuses).toHaveLength(1);
		});

		it('emits StatusChange again when status transitions to a different value', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsClosed', headId: HEAD_ID_A }));

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

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A.toUpperCase() }));

			expect(changes[0].headId).toBe(HEAD_ID_A);
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
					headId: HEAD_ID_A,
					contestationDeadline: '2026-06-01T00:00:00Z',
				}),
			);

			expect((changes[0] as { contestationDeadline: string }).contestationDeadline).toBe('2026-06-01T00:00:00Z');
		});

		it('rejects and invalidates a pinned head-scoped status that omits its head id', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', expectedHeadId: HEAD_ID_A });
			const connectPromise = node.connect();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Greetings', headStatus: 'Open', hydraHeadId: HEAD_ID_A }),
			);
			await connectPromise;
			const statusListener = jest.fn();
			node.on(HydraNodeEvent.StatusChange, statusListener);

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsFinalized' }));

			expect(statusListener).not.toHaveBeenCalled();
			expect(mockConnectionInstance.invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		});
	});

	describe('unsigned SnapshotConfirmed processing', () => {
		it('fails closed, invalidates the history socket, and retains no evidence', async () => {
			const { node, historyConnection } = await startSignedNode();
			const transaction = makeHydraTransaction(1);

			historyConnection.emit(
				'message',
				JSON.stringify({
					tag: 'SnapshotConfirmed',
					seq: 1,
					headId: HEAD_ID_A,
					snapshot: { confirmed: [transaction] },
				}),
			);

			expect(node.confirmedTransactionHistoryReady).toBe(false);
			expect(node.confirmedTransactionHistoryError).toBeInstanceOf(HydraProtocolError);
			expect(node.getConfirmedTransaction(transaction.txId)).toBeNull();
			expect(historyConnection.invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		});
	});

	describe('signed bounded history replay', () => {
		it('retains finalized fanout evidence across non-status frames and clears it on a live regression', async () => {
			const { node, historyConnection, liveConnection } = await startSignedNode();
			const chain = signedHistoryChain();
			for (const frame of chain.frames) historyConnection.emit('message', JSON.stringify(frame));
			finishHistoryReplay(historyConnection);
			const fanoutTxHash = '55'.repeat(32);
			liveConnection.emit(
				'message',
				JSON.stringify({
					tag: 'HeadIsFinalized',
					headId: HEAD_ID_A,
					utxo: { [`${fanoutTxHash}#0`]: snapshotOutput(7_000_000) },
				}),
			);
			const hydraReference = `${chain.transactions[2].txId}#0`;

			expect(node.getVerifiedFanoutReference(hydraReference, 3)).toEqual(
				expect.objectContaining({ txHash: fanoutTxHash, outputIndex: 0, snapshotNumber: 3 }),
			);
			liveConnection.emit(
				'message',
				JSON.stringify({
					tag: 'Tick',
					headId: HEAD_ID_A,
					chainTime: '2026-07-22T10:01:00Z',
					chainSlot: 1,
				}),
			);
			expect(node.getVerifiedFanoutReference(hydraReference, 3)).not.toBeNull();

			liveConnection.emit('message', JSON.stringify(liveGreetings()));
			expect(node.status).toBe(HydraHeadStatus.Open);
			expect(node.getVerifiedFanoutReference(hydraReference, 3)).toBeNull();
		});

		it('derives the surviving output from producer CBOR despite an unsigned reference-map permutation', async () => {
			const { node, historyConnection, liveConnection } = await startSignedNode();
			const chain = signedTwoOutputHistory();
			for (const frame of chain.frames) historyConnection.emit('message', JSON.stringify(frame));
			finishHistoryReplay(historyConnection);
			const fanoutTxHash = '56'.repeat(32);
			liveConnection.emit(
				'message',
				JSON.stringify({
					tag: 'HeadIsFinalized',
					headId: HEAD_ID_A,
					utxo: {
						[`${fanoutTxHash}#0`]: chain.firstFinalOutput,
						[`${fanoutTxHash}#1`]: chain.secondFinalOutput,
					},
				}),
			);

			expect(node.getVerifiedFanoutReference(`${chain.first.txId}#0`, 2)).toEqual(
				expect.objectContaining({
					txHash: fanoutTxHash,
					outputIndex: 0,
					snapshotNumber: 2,
				}),
			);
			expect(node.getVerifiedFanoutReference(`${chain.second.txId}#0`, 2)).toEqual(
				expect.objectContaining({
					txHash: fanoutTxHash,
					outputIndex: 1,
					snapshotNumber: 2,
				}),
			);
		});

		it('refuses candidate ownership when two final outputs have identical serialized values', async () => {
			const { node, historyConnection, liveConnection } = await startSignedNode();
			const chain = signedTwoOutputHistory({ duplicateFinalValues: true });
			for (const frame of chain.frames) historyConnection.emit('message', JSON.stringify(frame));
			finishHistoryReplay(historyConnection);
			const fanoutTxHash = '57'.repeat(32);
			liveConnection.emit(
				'message',
				JSON.stringify({
					tag: 'HeadIsFinalized',
					headId: HEAD_ID_A,
					utxo: {
						[`${fanoutTxHash}#0`]: chain.firstFinalOutput,
						[`${fanoutTxHash}#1`]: chain.secondFinalOutput,
					},
				}),
			);

			expect(node.getVerifiedFanoutReferences(2)).toHaveLength(2);
			expect(node.getVerifiedFanoutReference(`${chain.first.txId}#0`, 2)).toBeNull();
			expect(node.getVerifiedFanoutReference(`${chain.second.txId}#0`, 2)).toBeNull();
		});

		it.each(['history', 'live'] as const)(
			'fails closed permanently when the %s socket observes persistence rotation',
			async (socket) => {
				const { node, historyConnection, liveConnection } = await startSignedNode();
				const selectedConnection = socket === 'history' ? historyConnection : liveConnection;
				const transaction = makeHydraTransaction(47);

				selectedConnection.emit('message', JSON.stringify({ tag: 'EventLogRotated' }));

				expect(node.confirmedTransactionHistoryReady).toBe(false);
				expect(node.hasVerifiedPinnedSessions).toBe(false);
				expect(node.confirmedTransactionHistoryError?.message).toMatch(/event-log rotation is unsupported/);
				expect(node.getConfirmedTransactionsForReconciliation()).toEqual([]);
				expect(historyConnection.disconnect).toHaveBeenCalledTimes(1);
				expect(liveConnection.disconnect).toHaveBeenCalledTimes(1);
				expect(historyConnection.invalidate).not.toHaveBeenCalled();
				expect(liveConnection.invalidate).not.toHaveBeenCalled();
				await expect(node.newTx(transaction)).rejects.toThrow(/event-log rotation is unsupported/);
				await expect(node.cardanoTransaction(transaction)).rejects.toThrow(/event-log rotation is unsupported/);
				await expect(node.snapshotUTxO()).rejects.toThrow(/event-log rotation is unsupported/);
				expect(mockFetch).not.toHaveBeenCalled();
				await expect(node.connect()).rejects.toThrow(/event-log rotation is unsupported/);
			},
		);

		it('does not authenticate an Open replay from unsigned side-load and Greetings frames', async () => {
			const node = new HydraNode({
				httpUrl: 'http://localhost:4001',
				expectedHeadId: HEAD_ID_A,
				snapshotVerificationKeys: TEST_PARTIES.map(({ cborVerificationKey }) => cborVerificationKey),
				expectedNodeVerificationKey: TEST_PARTIES[0].cborVerificationKey,
				trustLocalNodeSnapshotMetadata: true,
			});
			const connectPromise = node.connect();
			const historyConnection = mockConnectionInstances[0];
			const liveConnection = mockConnectionInstances[1];
			liveConnection.emit('message', JSON.stringify(headIsOpen()));
			liveConnection.emit('message', JSON.stringify(liveGreetings()));
			await connectPromise;

			historyConnection.emit('message', JSON.stringify({ tag: 'SnapshotSideLoaded', headId: HEAD_ID_A }));
			finishHistoryReplay(historyConnection);

			expect(node.confirmedTransactionHistoryReady).toBe(false);
			expect(node.hasVerifiedPinnedSessions).toBe(false);
			expect(node.confirmedTransactionHistoryError?.message).toMatch(/without an authenticated Open/);
			expect(historyConnection.invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		});

		it('uses only the history socket and exposes verified positive evidence before Greetings', async () => {
			const { node, historyConnection, liveConnection } = await startSignedNode();
			const { frames, transactions } = signedHistoryChain();

			for (const frame of frames) liveConnection.emit('message', JSON.stringify(frame));
			expect(node.getConfirmedTransaction(transactions[0].txId)).toBeNull();

			for (const frame of frames) historyConnection.emit('message', JSON.stringify(frame));
			expect(node.confirmedTransactionHistoryReady).toBe(false);
			expect(node.getConfirmedTransactionsForReconciliation().map(({ txId }) => txId)).toEqual(
				transactions.map(({ txId }) => txId),
			);
			expect(node.getConfirmedTransaction(transactions[0].txId)).toEqual(
				expect.objectContaining({
					txId: transactions[0].txId,
					snapshotSequence: 2,
					snapshotTransactionIndex: 0,
					confirmedAtMs: Date.parse('2026-07-22T10:00:02Z'),
				}),
			);

			finishHistoryReplay(historyConnection);
			expect(node.confirmedTransactionHistoryReady).toBe(true);
			expect(node.hasVerifiedPinnedSessions).toBe(true);
		});

		it('buffers history evidence until a head id is explicitly pinned', async () => {
			const node = new HydraNode({
				httpUrl: 'http://localhost:4001',
				snapshotVerificationKeys: TEST_PARTIES.map(({ cborVerificationKey }) => cborVerificationKey),
				expectedNodeVerificationKey: TEST_PARTIES[0].cborVerificationKey,
				trustLocalNodeSnapshotMetadata: true,
			});
			const connectPromise = node.connect();
			const historyConnection = mockConnectionInstances[0];
			const liveConnection = mockConnectionInstances[1];
			liveConnection.emit('message', JSON.stringify(headIsOpen()));
			liveConnection.emit('message', JSON.stringify(liveGreetings()));
			await connectPromise;
			const { frames, transactions } = signedHistoryChain();

			historyConnection.emit('message', JSON.stringify(headIsOpen()));
			for (const frame of frames) historyConnection.emit('message', JSON.stringify(frame));
			expect(node.getConfirmedTransactionsForReconciliation()).toEqual([]);
			expect(node.getConfirmedTransaction(transactions[0].txId)).toBeNull();

			node.pinExpectedHeadId(HEAD_ID_A);

			expect(node.getConfirmedTransactionsForReconciliation().map(({ txId }) => txId)).toEqual(
				transactions.map(({ txId }) => txId),
			);
		});

		it('rejects buffered history from a different head when the expected id is pinned', async () => {
			const node = new HydraNode({
				httpUrl: 'http://localhost:4001',
				snapshotVerificationKeys: TEST_PARTIES.map(({ cborVerificationKey }) => cborVerificationKey),
				expectedNodeVerificationKey: TEST_PARTIES[0].cborVerificationKey,
				trustLocalNodeSnapshotMetadata: true,
			});
			const connectPromise = node.connect();
			const historyConnection = mockConnectionInstances[0];
			const liveConnection = mockConnectionInstances[1];
			liveConnection.emit('message', JSON.stringify(headIsOpen()));
			liveConnection.emit('message', JSON.stringify(liveGreetings()));
			await connectPromise;
			historyConnection.emit('message', JSON.stringify({ ...headIsOpen(), headId: HEAD_ID_B }));

			node.pinExpectedHeadId(HEAD_ID_A);

			expect(node.confirmedTransactionHistoryError).toBeInstanceOf(HydraProtocolError);
			expect(node.getConfirmedTransactionsForReconciliation()).toEqual([]);
			expect(historyConnection.invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		});

		it('verifies and records transactions in the first snapshot from the HeadIsOpen state', async () => {
			const { node, historyConnection } = await startSignedNode();
			const initialReference = `${'22'.repeat(32)}#0`;
			const initialUtxo = { [initialReference]: snapshotOutput(10_000_000) };
			const transaction = makeSpendingHydraTransaction('22'.repeat(32), 0, 9_000_000);
			historyConnection.emit('message', JSON.stringify(headIsOpen(initialUtxo)));
			historyConnection.emit(
				'message',
				JSON.stringify(
					signedSnapshotFrame({
						seq: 1,
						number: 1,
						utxo: { [`${transaction.txId}#0`]: snapshotOutput(9_000_000) },
						confirmed: [transaction],
					}),
				),
			);

			expect(node.getConfirmedTransaction(transaction.txId)).toEqual(
				expect.objectContaining({ txId: transaction.txId, snapshotSequence: 1 }),
			);
		});

		it('fails and reconnects instead of re-anchoring a non-consecutive signed snapshot', async () => {
			const { node, historyConnection } = await startSignedNode();
			const { frames, transactions } = signedHistoryChain();
			historyConnection.emit('message', JSON.stringify(frames[0]));
			historyConnection.emit('message', JSON.stringify(frames[2]));

			expect(node.confirmedTransactionHistoryError).toBeInstanceOf(HydraProtocolError);
			expect(node.getConfirmedTransaction(transactions[2].txId)).toBeNull();
			expect(historyConnection.invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		});

		it('never reports an unverified or non-two-party session as verified', () => {
			const unverifiedNode = new HydraNode({ httpUrl: 'http://localhost:4001', expectedHeadId: HEAD_ID_A });
			const onePartyNode = new HydraNode({
				httpUrl: 'http://localhost:4001',
				expectedHeadId: HEAD_ID_A,
				snapshotVerificationKeys: [TEST_PARTIES[0].cborVerificationKey],
				expectedNodeVerificationKey: TEST_PARTIES[0].cborVerificationKey,
			});

			expect(unverifiedNode.hasVerifiedPinnedSessions).toBe(false);
			expect(onePartyNode.hasVerifiedPinnedSessions).toBe(false);
		});

		it('advances an exact same-snapshot cursor and preserves the suffix', async () => {
			const { node, historyConnection } = await startSignedNode({
				reconciledHistoryCursor: { snapshotSequence: 2, snapshotTransactionIndex: 0 },
			});
			const { frames, transactions } = signedHistoryChain();

			for (const frame of frames) historyConnection.emit('message', JSON.stringify(frame));
			finishHistoryReplay(historyConnection);

			expect(node.getConfirmedTransaction(transactions[0].txId)).toBeNull();
			expect(node.getConfirmedTransactionsForReconciliation()).toEqual([
				expect.objectContaining({
					txId: transactions[1].txId,
					snapshotSequence: 2,
					snapshotTransactionIndex: 1,
				}),
				expect.objectContaining({
					txId: transactions[2].txId,
					snapshotSequence: 3,
					snapshotTransactionIndex: 0,
				}),
			]);
		});

		it('retains only the current signed live-output producer across a restart cursor', async () => {
			const { transactions, frames } = signedHistoryChain();
			const { node, historyConnection } = await startSignedNode({
				reconciledHistoryCursor: { snapshotSequence: 3, snapshotTransactionIndex: 0 },
				maxRetainedTransactionCborBytes: transactions[2].cborHex.length / 2,
			});

			for (const frame of frames) historyConnection.emit('message', JSON.stringify(frame));
			finishHistoryReplay(historyConnection);

			expect(node.confirmedTransactionHistoryReady).toBe(true);
			expect(node.getConfirmedTransactionsForReconciliation()).toEqual([]);
			expect(node.getConfirmedTransaction(transactions[0].txId)).toBeNull();
			expect(node.getConfirmedTransaction(transactions[1].txId)).toBeNull();
			expect(node.getConfirmedTransaction(transactions[2].txId)).toEqual(
				expect.objectContaining({ txId: transactions[2].txId, cborHex: transactions[2].cborHex }),
			);
		});

		it('pages a large replay without trusting a partial prefix as complete', async () => {
			const { node, historyConnection } = await startSignedNode({ maxUnreconciledTransactions: 1 });
			const { frames, transactions } = signedHistoryChain();

			for (const frame of frames) historyConnection.emit('message', JSON.stringify(frame));
			expect(node.getConfirmedTransactionsForReconciliation()).toEqual([
				expect.objectContaining({
					txId: transactions[0].txId,
					snapshotSequence: 2,
					snapshotTransactionIndex: 0,
				}),
			]);
			node.markConfirmedTransactionReconciled(transactions[0].txId);
			expect(historyConnection.invalidate).not.toHaveBeenCalled();
			finishHistoryReplay(historyConnection);
			expect(node.confirmedTransactionHistoryReady).toBe(false);
			expect(historyConnection.invalidate).toHaveBeenCalledTimes(1);

			historyConnection.emit('close', new Error('bounded page restart'));
			historyConnection.emit('message', JSON.stringify(headIsOpen()));
			for (const frame of frames) historyConnection.emit('message', JSON.stringify(frame));
			finishHistoryReplay(historyConnection);
			expect(node.getConfirmedTransactionsForReconciliation()).toEqual([
				expect.objectContaining({
					txId: transactions[1].txId,
					snapshotSequence: 2,
					snapshotTransactionIndex: 1,
				}),
			]);
			node.markConfirmedTransactionReconciled(transactions[1].txId);
			expect(historyConnection.invalidate).toHaveBeenCalledTimes(2);

			historyConnection.emit('close', new Error('bounded page restart'));
			historyConnection.emit('message', JSON.stringify(headIsOpen()));
			for (const frame of frames) historyConnection.emit('message', JSON.stringify(frame));
			finishHistoryReplay(historyConnection);
			expect(node.confirmedTransactionHistoryReady).toBe(true);
			expect(node.getConfirmedTransactionsForReconciliation()).toEqual([
				expect.objectContaining({ txId: transactions[2].txId }),
			]);
		});

		it('preserves verified evidence across an unexpected history reconnect', async () => {
			const { node, historyConnection } = await startSignedNode();
			const { frames, transactions } = signedHistoryChain();
			historyConnection.emit('message', JSON.stringify(frames[0]));
			historyConnection.emit('message', JSON.stringify(frames[1]));
			expect(node.getConfirmedTransactionsForReconciliation()).toHaveLength(2);

			historyConnection.emit('close', new Error('transport reset'));

			expect(node.confirmedTransactionHistoryReady).toBe(false);
			expect(node.getConfirmedTransactionsForReconciliation().map(({ txId }) => txId)).toEqual([
				transactions[0].txId,
				transactions[1].txId,
			]);
		});

		it('rejects out-of-order durable cursor advancement', async () => {
			const { node, historyConnection } = await startSignedNode();
			const { frames, transactions } = signedHistoryChain();
			historyConnection.emit('message', JSON.stringify(frames[0]));
			historyConnection.emit('message', JSON.stringify(frames[1]));

			expect(() => node.markConfirmedTransactionReconciled(transactions[1].txId)).toThrow(HydraProtocolError);
			expect(node.getConfirmedTransactionsForReconciliation()).toHaveLength(2);
		});

		it('fails closed when one transaction cannot fit in an otherwise empty byte page', async () => {
			const { node, historyConnection } = await startSignedNode({ maxRetainedTransactionCborBytes: 1 });
			const { frames, transactions } = signedHistoryChain();
			historyConnection.emit('message', JSON.stringify(frames[0]));
			historyConnection.emit('message', JSON.stringify(frames[1]));

			expect(node.confirmedTransactionHistoryError).toBeInstanceOf(HydraProtocolError);
			expect(node.getConfirmedTransaction(transactions[0].txId)).toBeNull();
		});

		it('rejects a non-monotonic signed history sequence', async () => {
			const { node, historyConnection } = await startSignedNode();
			const { frames } = signedHistoryChain();
			historyConnection.emit('message', JSON.stringify(frames[0]));
			historyConnection.emit('message', JSON.stringify({ ...frames[1], seq: 1 }));

			expect(node.confirmedTransactionHistoryReady).toBe(false);
			expect(node.confirmedTransactionHistoryError).toBeInstanceOf(HydraProtocolError);
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
			const { node, historyConnection } = await startSignedNode();
			const { frames, transactions } = signedHistoryChain();
			historyConnection.emit('message', JSON.stringify(frames[0]));
			historyConnection.emit('message', JSON.stringify(frames[1]));
			const tx = transactions[0];

			await expect(node.awaitTx(tx.txId, 100)).resolves.toBe(true);
		});

		it.each([0, -1, 1.5, Number.NaN])('rejects invalid polling interval %s', async (interval) => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			await expect(node.awaitTx('a'.repeat(64), interval)).rejects.toBeInstanceOf(HydraProtocolError);
		});

		it('rejects an unknown confirmation when the history socket closes', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', commandTimeoutMs: 100 });
			const confirmation = node.awaitTx('a'.repeat(64), 10);
			const rejection = expect(confirmation).rejects.toBeInstanceOf(HydraTransportAmbiguousError);

			mockConnectionInstances[0].emit('close', new Error('history connection lost'));

			await rejection;
			expect(mockConnectionInstances[0].listenerCount('close')).toBe(0);
			expect(mockConnectionInstances[1].listenerCount('close')).toBe(0);
		});
	});

	describe('newTx transport handling', () => {
		it('rejects a supplied txId that does not match command CBOR before sending', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			const transaction = makeHydraTransaction(37);
			const otherTransaction = makeHydraTransaction(38);

			await expect(node.newTx({ ...transaction, txId: otherTransaction.txId })).rejects.toBeInstanceOf(
				HydraProtocolError,
			);
			expect(mockConnectionInstance.send).not.toHaveBeenCalled();
		});

		it('correlates CommandFailed to only the matching concurrent transaction', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			const tx1 = makeHydraTransaction(16);
			const tx2 = makeHydraTransaction(17);
			const firstSubmit = node.newTx(tx1);
			const secondSubmit = node.newTx(tx2);
			const firstRejection = expect(firstSubmit).rejects.toBeInstanceOf(HydraTransactionRejectedError);

			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'CommandFailed', clientInput: { tag: 'NewTx', transaction: tx1 } }),
			);
			await firstRejection;
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'TxValid', headId: HEAD_ID_A, transactionId: tx2.txId }),
			);

			await expect(secondSubmit).resolves.toBe(tx2.txId);
		});

		it('does not accept a matching TxValid that omits the pinned head id', async () => {
			const { node, liveConnection } = await startSignedNode();
			const transaction = makeHydraTransaction(40);
			const submit = node.newTx(transaction);
			await Promise.resolve();

			liveConnection.emit('message', JSON.stringify({ tag: 'TxValid', transactionId: transaction.txId }));

			await expect(submit).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
			expect(liveConnection.invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		});

		it('rejects malformed frames without throwing from the message listener', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			const transaction = makeHydraTransaction(18);
			const submit = node.newTx(transaction);
			await Promise.resolve();

			expect(() => mockConnectionInstance.emit('message', '{')).not.toThrow();
			await expect(submit).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
			expect(mockConnectionInstance.listenerCount('message')).toBe(2);
		});

		it('rejects malformed TxInvalid safely instead of dereferencing a missing transaction', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			const submit = node.newTx(makeHydraTransaction(19));
			await Promise.resolve();

			expect(() => mockConnectionInstance.emit('message', JSON.stringify({ tag: 'TxInvalid' }))).not.toThrow();
			await expect(submit).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
		});

		it('rejects a queued transaction as ambiguous and cleans listeners when transport closes', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			const submit = node.newTx(makeHydraTransaction(20));
			await Promise.resolve();

			mockConnectionInstance.emit('close', new Error('connection lost'));
			await expect(submit).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
			expect(mockConnectionInstance.listenerCount('message')).toBe(2);
			// One permanent close listener resets pinned-session authentication.
			expect(mockConnectionInstance.listenerCount('close')).toBe(1);
		});
	});

	describe('head identity pinning', () => {
		it('normalizes case, is idempotent for one head, and rejects a different head', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', expectedHeadId: HEAD_ID_A.toUpperCase() });
			expect(node.expectedHeadId).toBe(HEAD_ID_A);
			expect(() => node.pinExpectedHeadId(HEAD_ID_A)).not.toThrow();
			expect(() => node.pinExpectedHeadId(HEAD_ID_B)).toThrow(HydraProtocolError);
		});

		it('rejects non-canonical configured and frame head identifiers', () => {
			expect(() => new HydraNode({ httpUrl: 'http://localhost:4001', expectedHeadId: 'head-a' })).toThrow(
				HydraProtocolError,
			);
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			const statusListener = jest.fn();
			node.on(HydraNodeEvent.StatusChange, statusListener);

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: 'head-a' }));

			expect(statusListener).not.toHaveBeenCalled();
		});

		it('ignores status and snapshot frames for a different pinned head', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', expectedHeadId: HEAD_ID_A });
			const connectPromise = node.connect();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Greetings', headStatus: 'Open', headId: HEAD_ID_A }),
			);
			await connectPromise;
			const statusListener = jest.fn();
			const confirmedListener = jest.fn();
			const transaction = makeHydraTransaction(21);
			node.on(HydraNodeEvent.StatusChange, statusListener);
			node.on(HydraNodeEvent.TxConfirmed, confirmedListener);

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_B }));
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'SnapshotConfirmed', headId: HEAD_ID_B, snapshot: { confirmed: [transaction] } }),
			);
			await flushMicrotasks();

			expect(statusListener).not.toHaveBeenCalled();
			expect(confirmedListener).not.toHaveBeenCalled();
			expect(node.getConfirmedTransaction(transaction.txId)).toBeNull();
		});

		it('waits for a matching identity-bearing Greetings and gates earlier status', async () => {
			const node = new HydraNode({
				httpUrl: 'http://localhost:4001',
				expectedHeadId: HEAD_ID_A,
				connectTimeoutMs: 100,
			});
			const statusListener = jest.fn();
			node.on(HydraNodeEvent.StatusChange, statusListener);
			let isConnected = false;
			const connectPromise = node.connect().then(() => {
				isConnected = true;
			});

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));
			await Promise.resolve();
			expect(isConnected).toBe(false);
			expect(statusListener).not.toHaveBeenCalled();

			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Greetings', headStatus: 'Open', headId: HEAD_ID_A.toUpperCase() }),
			);
			await connectPromise;
			expect(isConnected).toBe(true);
			expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({ headId: HEAD_ID_A }));
		});

		it('rejects startup when pinned Greetings belongs to another head', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', expectedHeadId: HEAD_ID_A });
			const connectPromise = node.connect();
			const rejection = expect(connectPromise).rejects.toBeInstanceOf(HydraProtocolError);

			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Greetings', headStatus: 'Open', headId: HEAD_ID_B }),
			);

			await rejection;
		});

		it('rejects a history Greetings that omits the pinned id after signed snapshots', async () => {
			const { node, historyConnection } = await startSignedNode();
			const { frames } = signedHistoryChain();
			historyConnection.emit('message', JSON.stringify(frames[0]));
			historyConnection.emit('message', JSON.stringify({ ...liveGreetings(), hydraHeadId: undefined }));

			expect(node.confirmedTransactionHistoryReady).toBe(false);
			expect(node.confirmedTransactionHistoryError).toBeInstanceOf(HydraProtocolError);
		});

		it('accepts only a party-authenticated headless Idle Greetings as a live rollback', async () => {
			const { node, liveConnection } = await startSignedNode();
			const statuses: HydraHeadStatus[] = [];
			node.on(HydraNodeEvent.StatusChange, (data) => statuses.push((data as { status: HydraHeadStatus }).status));

			liveConnection.emit(
				'message',
				JSON.stringify({ ...liveGreetings(), headStatus: 'Idle', hydraHeadId: undefined }),
			);

			expect(node.status).toBe(HydraHeadStatus.Idle);
			expect(statuses).toContain(HydraHeadStatus.Idle);
			expect(node.hasVerifiedPinnedSessions).toBe(false);
			expect(liveConnection.invalidate).not.toHaveBeenCalled();
		});

		it('invalidates an authenticated session after a conflicting identity frame', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', expectedHeadId: HEAD_ID_A });
			const connectPromise = node.connect();
			const transaction = makeHydraTransaction(39);
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Greetings', headStatus: 'Open', headId: HEAD_ID_A }),
			);
			await connectPromise;
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:19:17Z', headId: HEAD_ID_A }),
			);
			expect(node.headClock).toBeDefined();

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_B }));
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'SnapshotConfirmed', snapshot: { confirmed: [transaction] } }),
			);
			await flushMicrotasks();

			expect(node.headClock).toBeUndefined();
			expect(mockConnectionInstance.invalidate).toHaveBeenCalledWith(expect.any(Error));
			expect(node.getConfirmedTransaction(transaction.txId)).toBeNull();
		});
	});

	describe('init()', () => {
		it('sends Init and resolves when HeadIsInitializing is received', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const initPromise = node.init();
			expect(mockConnectionInstance.send).toHaveBeenCalledWith({ tag: 'Init' });

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsInitializing', headId: HEAD_ID_A }));
			await expect(initPromise).resolves.toBeUndefined();
		});

		it('does not resolve Init from a head-scoped frame without a head id', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			const initPromise = node.init(1000);
			await Promise.resolve();

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsInitializing' }));

			await expect(initPromise).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
			expect(mockConnectionInstance.invalidate).toHaveBeenCalledWith(expect.any(HydraProtocolError));
		});

		it('resolves when the head fast-forwards straight to HeadIsOpen (hydra-node 2.x)', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const initPromise = node.init();
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));
			await expect(initPromise).resolves.toBeUndefined();
		});

		it('resolves when a Greetings reports the head is already Initializing', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();

			const initPromise = node.init();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Greetings', headStatus: 'Initializing', hydraHeadId: HEAD_ID_A }),
			);
			await expect(initPromise).resolves.toBeUndefined();
		});

		it('returns immediately without sending Init when the head is already open', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			// Drive status to Open first.
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsOpen', headId: HEAD_ID_A }));
			expect(node.status).toBe(HydraHeadStatus.Open);

			mockConnectionInstance.send.mockClear();
			await expect(node.init()).resolves.toBeUndefined();
			expect(mockConnectionInstance.send).not.toHaveBeenCalled();
		});
	});

	describe('close()', () => {
		it('sends Close once and still accepts a late HeadIsClosed response', async () => {
			jest.useFakeTimers();
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			void node.connect();

			const closePromise = node.close();
			await Promise.resolve();
			expect(mockConnectionInstance.send).toHaveBeenCalledTimes(1);

			jest.advanceTimersByTime(120_000);
			await Promise.resolve();
			expect(mockConnectionInstance.send).toHaveBeenCalledTimes(1);

			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'HeadIsClosed', headId: HEAD_ID_A }));
			await expect(closePromise).resolves.toBeUndefined();
		});

		it('treats a post-dispatch Close rejection as ambiguous', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			void node.connect();

			const closePromise = node.close();
			await Promise.resolve();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'CommandFailed', clientInput: { tag: 'Close' }, headId: HEAD_ID_A }),
			);

			await expect(closePromise).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
			expect(mockConnectionInstance.send).toHaveBeenCalledTimes(1);
		});
	});

	describe('HTTP methods', () => {
		it('get() calls fetch with GET and correct URL', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			mockFetch.mockResolvedValue({
				json: async () => ({ key: 'value' }),
			} as Response);

			const result = await node.get('/snapshot/utxo');

			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:4001/snapshot/utxo',
				expect.objectContaining({
					method: 'GET',
					headers: { 'Content-Type': 'application/json' },
					redirect: 'error',
					signal: expect.anything(),
				}),
			);
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
					redirect: 'error',
					signal: expect.anything(),
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

			await expect(node.get('/bad-endpoint')).rejects.toThrow('Hydra HTTP response was not valid JSON');
		});

		it('get() throws with a JSON error body on a non-2xx response', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			mockFetch.mockResolvedValue({
				ok: false,
				status: 400,
				statusText: 'Bad Request',
				json: async () => ({ tag: 'InvalidInput', reason: 'bad commit' }),
			} as Response);

			await expect(node.get('/commit')).rejects.toThrow('Hydra HTTP request failed with 400 Bad Request');
		});

		it('post() treats a 5xx response after dispatch as ambiguous', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			const syntaxError = new SyntaxError('Unexpected token');

			mockFetch.mockResolvedValue({
				ok: false,
				status: 502,
				statusText: 'Bad Gateway',
				json: async () => {
					throw syntaxError;
				},
				text: async () => 'upstream unavailable',
			} as unknown as Response);

			await expect(node.post('/cardano-transaction', {})).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
		});

		it('post() keeps an explicit 4xx rejection deterministic', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({
				ok: false,
				status: 400,
				statusText: 'Bad Request',
				json: async () => ({ tag: 'InvalidInput' }),
			} as Response);

			await expect(node.post('/commit', {})).rejects.toThrow('Hydra HTTP request failed with 400 Bad Request');
		});

		it('post() treats response transport failures after dispatch as ambiguous', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			const networkError = new Error('Network failure');

			mockFetch.mockResolvedValue({
				json: async () => {
					throw networkError;
				},
			} as unknown as Response);

			await expect(node.post('/commit', {})).rejects.toBeInstanceOf(HydraTransportAmbiguousError);
		});

		it('bounds HTTP responses before parsing them', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({
				ok: true,
				text: async () => 'x'.repeat(4 * 1024 * 1024 + 1),
			} as unknown as Response);

			await expect(node.get('/oversized')).rejects.toThrow('exceeded its byte limit');
		});

		it('aborts a timed-out POST and reports an ambiguous outcome', async () => {
			jest.useFakeTimers();
			const node = new HydraNode({ httpUrl: 'http://localhost:4001', httpTimeoutMs: 100 });
			mockFetch.mockImplementation(
				(_url, init) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
					}),
			);
			const request = node.post('/commit', {});
			const rejection = expect(request).rejects.toBeInstanceOf(HydraTransportAmbiguousError);

			jest.advanceTimersByTime(100);

			await rejection;
		});

		it.each([
			['negative', -1],
			['non-integer', 1.5],
			['non-finite', Number.POSITIVE_INFINITY],
			['unsafe', Number.MAX_SAFE_INTEGER + 1],
		])('snapshotUTxO() rejects a %s quantity', async (_description, quantity) => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({
				json: async () => ({
					[`${'a'.repeat(64)}#0`]: {
						address: 'addr_test1_valid',
						value: { lovelace: quantity },
						referenceScript: null,
						datumhash: null,
						inlineDatum: null,
						inlineDatumRaw: null,
						datum: null,
					},
				}),
			} as unknown as Response);

			await expect(node.snapshotUTxO()).rejects.toBeInstanceOf(HydraProtocolError);
		});

		it('snapshotUTxO() preserves a valid uint64 quantity above the JavaScript safe range', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({
				ok: true,
				text: async () =>
					`{"${'a'.repeat(64)}#0":{"address":"addr_test1_valid","value":{"lovelace":9007199254740993},"referenceScript":null,"datumhash":null,"inlineDatum":null,"inlineDatumRaw":null,"datum":null}}`,
			} as unknown as Response);

			await expect(node.snapshotUTxO()).resolves.toEqual([
				expect.objectContaining({
					output: expect.objectContaining({
						amount: [{ unit: 'lovelace', quantity: '9007199254740993' }],
					}),
				}),
			]);
		});

		it.each([`${'a'.repeat(63)}#-1`, `${'a'.repeat(64)}#4294967296`])(
			'snapshotUTxO() rejects malformed output reference %s',
			async (outputReference) => {
				const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
				mockFetch.mockResolvedValue({
					json: async () => ({
						[outputReference]: {
							address: 'addr_test1_valid',
							value: { lovelace: 1 },
							referenceScript: null,
							datumhash: null,
							inlineDatum: null,
							inlineDatumRaw: null,
							datum: null,
						},
					}),
				} as unknown as Response);

				await expect(node.snapshotUTxO()).rejects.toBeInstanceOf(HydraProtocolError);
			},
		);

		it('snapshotUTxO() rejects non-hex datum bytes', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({
				json: async () => ({
					[`${'a'.repeat(64)}#0`]: {
						address: 'addr_test1_valid',
						value: { lovelace: 1 },
						referenceScript: null,
						datumhash: null,
						inlineDatum: null,
						inlineDatumRaw: 'not-hex',
						datum: null,
					},
				}),
			} as unknown as Response);

			await expect(node.snapshotUTxO()).rejects.toBeInstanceOf(HydraProtocolError);
		});
	});

	describe('fetchProtocolParameters()', () => {
		it('rejects incomplete or non-finite protocol parameters at runtime', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({ json: async () => ({ maxTxSize: Number.NaN }) } as unknown as Response);

			await expect(node.fetchProtocolParameters()).rejects.toBeInstanceOf(HydraProtocolError);
		});
	});

	describe('fetchRawCostModels()', () => {
		it('extracts the head costModels from /protocol-parameters', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			mockFetch.mockResolvedValue({
				json: async () => ({
					costModels: {
						PlutusV1: [1, 2, 3],
						PlutusV2: [4, 5, 6, 7],
						PlutusV3: [8, 9],
					},
				}),
			} as Response);

			const result = await node.fetchRawCostModels();

			expect(mockFetch).toHaveBeenCalledWith(
				'http://localhost:4001/protocol-parameters',
				expect.objectContaining({ method: 'GET', redirect: 'error', signal: expect.anything() }),
			);
			expect(result).toEqual({
				PlutusV1: [1, 2, 3],
				PlutusV2: [4, 5, 6, 7],
				PlutusV3: [8, 9],
			});
		});

		it('coerces numeric-string cost-model entries to numbers', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			mockFetch.mockResolvedValue({
				json: async () => ({
					costModels: { PlutusV2: ['100', '200', 300] },
				}),
			} as Response);

			const result = await node.fetchRawCostModels();

			expect(result.PlutusV2).toEqual([100, 200, 300]);
		});

		it('returns undefined per-language when costModels is absent', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			mockFetch.mockResolvedValue({
				json: async () => ({ utxoCostPerByte: 4310 }),
			} as Response);

			const result = await node.fetchRawCostModels();

			expect(result).toEqual({ PlutusV1: undefined, PlutusV2: undefined, PlutusV3: undefined });
		});

		it('rejects a present language array containing an invalid entry', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });

			mockFetch.mockResolvedValue({
				json: async () => ({
					costModels: { PlutusV2: [1, 'not-a-number', 3] },
				}),
			} as Response);

			await expect(node.fetchRawCostModels()).rejects.toBeInstanceOf(HydraProtocolError);
		});

		it('rejects an oversized or unsafe present cost model array', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({
				json: async () => ({
					costModels: {
						PlutusV1: new Array(513).fill(1),
						PlutusV2: [Number.MAX_SAFE_INTEGER + 1],
					},
				}),
			} as Response);

			await expect(node.fetchRawCostModels()).rejects.toBeInstanceOf(HydraProtocolError);
		});

		it('rejects an unsafe integer in a present cost model', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			mockFetch.mockResolvedValue({
				json: async () => ({ costModels: { PlutusV2: [Number.MAX_SAFE_INTEGER + 1] } }),
			} as Response);

			await expect(node.fetchRawCostModels()).rejects.toBeInstanceOf(HydraProtocolError);
		});

		it('accepts the 297-entry Plutus V3 cost model', async () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			const plutusV3 = Array.from({ length: 297 }, (_value, index) => index - 100);
			mockFetch.mockResolvedValue({
				json: async () => ({ costModels: { PlutusV3: plutusV3 } }),
			} as Response);

			await expect(node.fetchRawCostModels()).resolves.toEqual({
				PlutusV1: undefined,
				PlutusV2: undefined,
				PlutusV3: plutusV3,
			});
		});
	});

	describe('head clock tracking', () => {
		it('captures chainTime/chainSlot from a Tick message', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:19:17Z', chainSlot: 127811957 }),
			);
			expect(node.headClock).toBeDefined();
			expect(node.headClock!.chainTimeMs).toBe(Date.parse('2026-07-08T07:19:17Z'));
			expect(node.headClock!.chainSlot).toBe(127811957);
			expect(node.headClock!.receivedAtMs).toBeGreaterThan(0);
		});

		it('captures the clock from a SyncedStatusReport message', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({
					tag: 'SyncedStatusReport',
					chainSlot: 127811957,
					chainTime: '2026-07-08T07:19:17Z',
					drift: 7735.89,
					synced: 'CatchingUp',
				}),
			);
			expect(node.headClock!.chainTimeMs).toBe(Date.parse('2026-07-08T07:19:17Z'));
		});

		it('keeps the newest clock and ignores unrelated/invalid messages', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:00:00Z', chainSlot: 1 }),
			);
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'Greetings', headStatus: 'Open' }));
			mockConnectionInstance.emit('message', 'not-json');
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:19:17Z', chainSlot: 2 }),
			);
			expect(node.headClock!.chainSlot).toBe(2);
		});

		it('ignores a clock message with an unparseable chainTime', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'Tick', chainTime: 'not-a-time' }));
			expect(node.headClock).toBeUndefined();
		});

		it('ignores implausibly future-dated clocks', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			mockConnectionInstance.emit('message', JSON.stringify({ tag: 'Tick', chainTime: '2999-01-01T00:00:00Z' }));
			expect(node.headClock).toBeUndefined();
		});

		it('clears the cached clock immediately when the live session closes', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			mockConnectionInstance.emit(
				'message',
				JSON.stringify({ tag: 'Tick', chainTime: '2026-07-08T07:19:17Z', chainSlot: 1 }),
			);
			expect(node.headClock).toBeDefined();

			mockConnectionInstance.emit('close', new Error('session closed'));

			expect(node.headClock).toBeUndefined();
		});

		it('returns undefined before any clock message', () => {
			const node = new HydraNode({ httpUrl: 'http://localhost:4001' });
			node.connect();
			expect(node.headClock).toBeUndefined();
		});
	});
});
