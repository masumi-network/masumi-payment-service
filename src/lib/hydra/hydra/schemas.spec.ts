import { describe, it, expect } from '@jest/globals';
import {
	messageSchema,
	hydraHeadStatusSchema,
	hydraTransactionSchema,
	snapshotConfirmedMessageSchema,
	headClockMessageSchema,
} from './schemas';

describe('messageSchema', () => {
	it('parses a Greetings message with headStatus', () => {
		const result = messageSchema.parse({ tag: 'Greetings', headStatus: 'Open' });
		expect(result.tag).toBe('Greetings');
		expect(result.headStatus).toBe('Open');
	});

	it('parses HeadIsOpen message (no extra fields required)', () => {
		const result = messageSchema.parse({ tag: 'HeadIsOpen', headId: 'abc123' });
		expect(result.tag).toBe('HeadIsOpen');
		expect(result.headId).toBe('abc123');
	});

	it('is loose — allows extra unknown fields', () => {
		const result = messageSchema.parse({ tag: 'Unknown', extraField: 42 });
		expect(result.tag).toBe('Unknown');
	});

	it('rejects message without tag', () => {
		expect(() => messageSchema.parse({ headStatus: 'Open' })).toThrow();
	});
});

describe('hydraHeadStatusSchema', () => {
	it('accepts all valid statuses', () => {
		const validStatuses = [
			'Disconnected',
			'Connected',
			'Connecting',
			'Idle',
			'Initializing',
			'Open',
			'Closed',
			'FanoutPossible',
			'Final',
		];
		for (const status of validStatuses) {
			expect(() => hydraHeadStatusSchema.parse(status)).not.toThrow();
		}
	});

	it('rejects unknown status string', () => {
		expect(() => hydraHeadStatusSchema.parse('Exploded')).toThrow();
	});
});

describe('hydraTransactionSchema', () => {
	it('parses a valid transaction with TxConwayEra type', () => {
		const result = hydraTransactionSchema.parse({
			type: 'Tx ConwayEra',
			cborHex: 'deadbeef',
			description: 'test tx',
			txId: 'abc123',
		});
		expect(result.type).toBe('Tx ConwayEra');
		expect(result.txId).toBe('abc123');
	});

	it('parses a valid transaction with UnwitnessedTxConwayEra type', () => {
		const result = hydraTransactionSchema.parse({
			type: 'Unwitnessed Tx ConwayEra',
			cborHex: 'cafe',
			description: 'unwitnessed',
			txId: 'tx002',
		});
		expect(result.type).toBe('Unwitnessed Tx ConwayEra');
		expect(result.txId).toBe('tx002');
	});

	it('parses a valid transaction with WitnessedTxConwayEra type', () => {
		const result = hydraTransactionSchema.parse({
			type: 'Witnessed Tx ConwayEra',
			cborHex: 'babe',
			description: 'witnessed',
			txId: 'tx003',
		});
		expect(result.type).toBe('Witnessed Tx ConwayEra');
		expect(result.txId).toBe('tx003');
	});

	it('rejects transaction with unknown type', () => {
		expect(() =>
			hydraTransactionSchema.parse({
				type: 'Tx BabbageEra',
				cborHex: 'deadbeef',
				description: '',
				txId: 'abc',
			}),
		).toThrow();
	});

	it('rejects transaction missing cborHex', () => {
		expect(() => hydraTransactionSchema.parse({ type: 'Tx ConwayEra', description: '', txId: 'abc' })).toThrow();
	});

	it('rejects transaction missing description', () => {
		expect(() => hydraTransactionSchema.parse({ type: 'Tx ConwayEra', cborHex: 'cafe', txId: 'abc' })).toThrow();
	});

	it('rejects transaction missing txId', () => {
		expect(() =>
			hydraTransactionSchema.parse({
				type: 'Tx ConwayEra',
				cborHex: 'cafe',
				description: 'test',
			}),
		).toThrow();
	});
});

describe('snapshotConfirmedMessageSchema', () => {
	const headId = 'ab'.repeat(28);
	const makeSnapshotConfirmed = (confirmed: Array<Record<string, string>>) => ({
		tag: 'SnapshotConfirmed' as const,
		headId,
		signatures: { multiSignature: ['cd'.repeat(64)] },
		snapshot: {
			headId,
			version: 0,
			number: 1,
			accumulator: 'ef'.repeat(32),
			confirmed,
			utxo: {},
			utxoToCommit: {},
			utxoToDecommit: {},
		},
	});

	it('parses a SnapshotConfirmed message with confirmed txs', () => {
		const result = snapshotConfirmedMessageSchema.parse(
			makeSnapshotConfirmed([
				{ type: 'Tx ConwayEra', cborHex: 'cafe', description: '', txId: 'tx001' },
				{ type: 'Tx ConwayEra', cborHex: 'babe', description: '', txId: 'tx002' },
			]),
		);
		expect(result.snapshot.confirmed).toHaveLength(2);
		expect(result.snapshot.confirmed[0].txId).toBe('tx001');
	});

	it('parses with empty confirmed array', () => {
		const result = snapshotConfirmedMessageSchema.parse(makeSnapshotConfirmed([]));
		expect(result.snapshot.confirmed).toHaveLength(0);
	});

	it('rejects wrong tag', () => {
		expect(() =>
			snapshotConfirmedMessageSchema.parse({
				tag: 'HeadIsOpen',
				snapshot: { confirmed: [] },
			}),
		).toThrow();
	});

	it('rejects missing snapshot field', () => {
		expect(() =>
			snapshotConfirmedMessageSchema.parse({
				tag: 'SnapshotConfirmed',
			}),
		).toThrow();
	});

	it('rejects missing confirmed array in snapshot', () => {
		expect(() =>
			snapshotConfirmedMessageSchema.parse({
				tag: 'SnapshotConfirmed',
				snapshot: {},
			}),
		).toThrow();
	});
});

describe('headClockMessageSchema', () => {
	it('parses a Tick message', () => {
		const parsed = headClockMessageSchema.parse({
			tag: 'Tick',
			chainTime: '2026-07-08T07:19:17Z',
			chainSlot: 127811957,
		});
		expect(parsed.tag).toBe('Tick');
		expect(parsed.chainTime).toBe('2026-07-08T07:19:17Z');
		expect(parsed.chainSlot).toBe(127811957);
	});

	it('parses a SyncedStatusReport message (extra fields ignored)', () => {
		const parsed = headClockMessageSchema.parse({
			tag: 'SyncedStatusReport',
			chainSlot: 127811957,
			chainTime: '2026-07-08T07:19:17Z',
			drift: 7735.89,
			synced: 'CatchingUp',
		});
		expect(parsed.tag).toBe('SyncedStatusReport');
	});

	it('parses a Tick without chainSlot', () => {
		const parsed = headClockMessageSchema.parse({ tag: 'Tick', chainTime: '2026-07-08T07:19:17Z' });
		expect(parsed.chainSlot).toBeUndefined();
	});

	it('rejects other tags', () => {
		expect(() => headClockMessageSchema.parse({ tag: 'Greetings', chainTime: '2026-07-08T07:19:17Z' })).toThrow();
	});

	it('rejects missing chainTime', () => {
		expect(() => headClockMessageSchema.parse({ tag: 'Tick', chainSlot: 5 })).toThrow();
	});
});
