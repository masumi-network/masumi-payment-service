import { describe, expect, it } from '@jest/globals';
import {
	fetchHydraAcknowledgedDeposits,
	fetchHydraClosedHeadFacts,
	fetchHydraPendingDecommitRefs,
	fetchHydraSnapshotRound,
} from './node-control-queries';
import { HydraProtocolError, HydraTransportError } from './errors';
import { HydraHttpResponseError } from './node-http-response';

const TX_ID = 'DC3EDEE5C3EB0B5B50809EC9FA41FB590818412383DA4F03CBF645FB0C1728E7';

function transportReturning(body: unknown) {
	const paths: string[] = [];
	return {
		paths,
		get: async <T>(url: string): Promise<T> => {
			paths.push(url);
			return body as T;
		},
	};
}

function transportThrowing(error: Error) {
	return {
		get: async <T>(_url: string): Promise<T> => {
			throw error;
		},
	};
}

describe('fetchHydraPendingDecommitRefs', () => {
	// An empty list lets a caller start an in-head split, and one started while
	// a decommit is pending is accepted but never snapshot-confirmed.
	// The two shapes an unreachable node takes: a direct connection failure, and
	// hydra-host's 502 when it cannot reach the node behind it.
	it.each([
		['the connection fails', new HydraTransportError('Hydra HTTP GET failed before a response was received')],
		['the proxy answers 502', new HydraHttpResponseError('Hydra HTTP request failed with 502 Bad Gateway', 502)],
	])('reads the head state as unknown, never as nothing pending, when %s', async (_label, error) => {
		await expect(fetchHydraPendingDecommitRefs(transportThrowing(error))).resolves.toBeUndefined();
	});

	// An oversized `/head` response cannot prove a prior decommit settled.
	// Returning [] would admit a split that can never snapshot-confirm.
	it('keeps the guard unknown when the head response exceeds its byte limit', async () => {
		const transport = transportThrowing(new HydraProtocolError('Hydra HTTP response exceeded its byte limit'));

		await expect(fetchHydraPendingDecommitRefs(transport)).resolves.toBeUndefined();
	});
});

describe('fetchHydraClosedHeadFacts', () => {
	const HEAD_ID = 'd7f3a349772cb36206c2005f108b77bdad46da96b1a6378702feed00';
	const closedHead = {
		tag: 'Closed',
		contents: {
			headId: HEAD_ID,
			contestationDeadline: '2026-10-22T12:00:00Z',
			confirmedSnapshot: { tag: 'ConfirmedSnapshot', snapshot: { number: 7 } },
		},
	};

	it('reads the deadline from one read of the head state', async () => {
		const transport = transportReturning(closedHead);

		await expect(fetchHydraClosedHeadFacts(transport, HEAD_ID)).resolves.toEqual({
			contestationDeadline: '2026-10-22T12:00:00Z',
		});
		expect(transport.paths).toEqual(['/head']);
	});

	// A head that cannot be read is not a head with no deadline: the
	// caller writes nothing, and a later read can still fill the row in.
	it.each([
		['the connection fails', new HydraTransportError('Hydra HTTP GET failed before a response was received')],
		['the proxy answers 502', new HydraHttpResponseError('Hydra HTTP request failed with 502 Bad Gateway', 502)],
		['the answer is over the byte limit', new HydraProtocolError('Hydra HTTP response exceeded its byte limit')],
	])('says nothing when %s', async (_label, error) => {
		await expect(fetchHydraClosedHeadFacts(transportThrowing(error), HEAD_ID)).resolves.toBeUndefined();
	});
});

describe('fetchHydraSnapshotRound', () => {
	it('reads a SeenSnapshot round as in flight, with its number, signers and transactions', async () => {
		// Shape captured from hydra-node 2.4.1 on a wedged mainnet head.
		const transport = transportReturning({
			tag: 'SeenSnapshot',
			snapshot: {
				headId: 'f6ec7beb99b731e4f2d359d6e77c0b429c7c8b98ddceb234a7622cae',
				number: 314,
				version: 52,
				accumulator: 'b98e',
				confirmed: [{ txId: TX_ID, cborHex: '84a6', description: '', type: 'Tx ConwayEra' }],
				utxo: {},
			},
			signatories: { eb4b8373ce63fc7156ec2e770a5b6679a953b54c28b82387173af53a040e7374: '5404' },
		});

		const round = await fetchHydraSnapshotRound(transport);

		expect(transport.paths).toEqual(['/snapshot/last-seen']);
		expect(round).toEqual({
			inFlight: true,
			tag: 'SeenSnapshot',
			number: 314,
			signatoryCount: 1,
			txIds: [TX_ID.toLowerCase()],
			signature: 'SeenSnapshot|314|1',
		});
	});

	it('changes the signature when another party signs, so a moving round is never called stuck', async () => {
		const base = { tag: 'SeenSnapshot', snapshot: { number: 314 } };
		const one = await fetchHydraSnapshotRound(transportReturning({ ...base, signatories: { a: '1' } }));
		const two = await fetchHydraSnapshotRound(transportReturning({ ...base, signatories: { a: '1', b: '2' } }));
		expect(one.signature).not.toBe(two.signature);
	});

	it('reads a RequestedSnapshot round by its requested number', async () => {
		const round = await fetchHydraSnapshotRound(
			transportReturning({ tag: 'RequestedSnapshot', lastSeen: 313, requested: 314 }),
		);
		expect(round).toMatchObject({ inFlight: true, number: 314, signature: 'RequestedSnapshot|314|0' });
	});

	it.each([[{ tag: 'LastSeenSnapshot', lastSeen: 313 }], [{ tag: 'NoSeenSnapshot' }]])(
		'reads %j as idle',
		async (body) => {
			const round = await fetchHydraSnapshotRound(transportReturning(body));
			expect(round.inFlight).toBe(false);
			expect(round.number).toBeNull();
		},
	);

	it('treats an unknown tag as a round in flight, never as idle', async () => {
		const round = await fetchHydraSnapshotRound(transportReturning({ tag: 'SomeFutureTag' }));
		expect(round.inFlight).toBe(true);
	});

	it.each([
		[null],
		[{}],
		[{ tag: 'SeenSnapshot', snapshot: { number: -1 } }],
		[{ tag: 'SeenSnapshot', snapshot: { number: 1, confirmed: [{ txId: 'zz' }] } }],
	])('rejects a malformed answer %j', async (body) => {
		await expect(fetchHydraSnapshotRound(transportReturning(body))).rejects.toBeInstanceOf(HydraProtocolError);
	});

	it('rejects more signatures than a head has parties', async () => {
		const signatories = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`vk${i}`, 'sig']));
		await expect(
			fetchHydraSnapshotRound(transportReturning({ tag: 'SeenSnapshot', snapshot: { number: 1 }, signatories })),
		).rejects.toBeInstanceOf(HydraProtocolError);
	});
});

describe('fetchHydraAcknowledgedDeposits', () => {
	const DEPOSIT_TX = 'DD'.repeat(32);
	const OUTPUT = {
		address: 'addr_test1vz',
		value: { lovelace: 5_000_000 },
		referenceScript: null,
		inlineDatum: null,
		inlineDatumRaw: null,
		datum: null,
	};
	const IDLE_ROUND = { tag: 'LastSeenSnapshot', lastSeen: 7 };
	const NO_DEPOSIT = { utxoToCommit: null, depositTxId: null };
	const snapshotBody = (fields: { utxoToCommit?: unknown; depositTxId?: string | null }) => ({
		headId: 'cc'.repeat(28),
		version: 1,
		number: 7,
		confirmed: [],
		utxo: {},
		...fields,
	});
	const confirmed = (fields: { utxoToCommit?: unknown; depositTxId?: string | null }) => ({
		tag: 'ConfirmedSnapshot',
		signatures: { multiSignature: [] },
		snapshot: snapshotBody(fields),
	});

	/** Answers `GET /snapshot` and `GET /snapshot/last-seen`. */
	function nodeAnswering(snapshot: unknown, lastSeen: unknown = IDLE_ROUND) {
		return {
			get: async <T>(url: string): Promise<T> => (url === '/snapshot/last-seen' ? lastSeen : snapshot) as T,
		};
	}

	it('reads the deposit a confirmed snapshot holds, with its id in lowercase', async () => {
		const transport = nodeAnswering(
			confirmed({ utxoToCommit: { [`${DEPOSIT_TX}#0`]: OUTPUT }, depositTxId: DEPOSIT_TX }),
		);

		await expect(fetchHydraAcknowledgedDeposits(transport)).resolves.toEqual([DEPOSIT_TX.toLowerCase()]);
	});

	// A signed round that confirms between the two reads must show up in the
	// second one. Asking for both at once would let it slip past both.
	it('asks for the confirmed snapshot only once the round in flight has answered', async () => {
		let answerRound: (body: unknown) => void = () => undefined;
		const paths: string[] = [];
		const transport = {
			get: async <T>(url: string): Promise<T> => {
				paths.push(url);
				if (url !== '/snapshot/last-seen') return confirmed(NO_DEPOSIT) as T;
				return await new Promise<T>((resolve) => {
					answerRound = (body) => resolve(body as T);
				});
			},
		};

		const acknowledged = fetchHydraAcknowledgedDeposits(transport);
		await Promise.resolve();
		expect(paths).toEqual(['/snapshot/last-seen']);

		answerRound(IDLE_ROUND);
		await expect(acknowledged).resolves.toEqual([]);
		expect(paths).toEqual(['/snapshot/last-seen', '/snapshot']);
	});

	/** A node reporting `roundTag` that refuses `GET /snapshot` with `status`. */
	function refusingSnapshot(status: number, roundTag: string) {
		const error = new HydraHttpResponseError(`Hydra HTTP request failed with ${status}`, status);
		const transport = {
			get: async <T>(url: string): Promise<T> => {
				if (url === '/snapshot/last-seen') return { tag: roundTag, lastSeen: 7 } as T;
				throw error;
			},
		};
		return { error, transport };
	}

	// hydra-node answers 404 for an Idle head, which is where a head ends after
	// fanout, and an Idle head reports NoSeenSnapshot.
	it('reads a node that holds no head as holding no deposit', async () => {
		const { transport } = refusingSnapshot(404, 'NoSeenSnapshot');

		await expect(fetchHydraAcknowledgedDeposits(transport)).resolves.toEqual([]);
	});

	// A Closed head reports LastSeenSnapshot, so a 404 beside it came from
	// something in front of the node, not from an Idle head.
	it.each([
		['a 404 beside a round tag an Idle head never reports', 404, 'LastSeenSnapshot'],
		['a 409', 409, 'NoSeenSnapshot'],
		['a 503', 503, 'NoSeenSnapshot'],
	])('passes on %s from the confirmed snapshot', async (_label, status, roundTag) => {
		const { error, transport } = refusingSnapshot(status, roundTag);

		await expect(fetchHydraAcknowledgedDeposits(transport)).rejects.toBe(error);
	});

	it.each([
		['null', null],
		['absent', undefined],
		['empty', {}],
	])('reads a snapshot whose utxoToCommit is %s as holding no deposit', async (_label, utxoToCommit) => {
		const transport = nodeAnswering(confirmed({ utxoToCommit, depositTxId: null }));

		await expect(fetchHydraAcknowledgedDeposits(transport)).resolves.toEqual([]);
	});

	it('reads a head still on its initial snapshot as holding no deposit', async () => {
		const transport = nodeAnswering({ tag: 'InitialSnapshot', headId: 'cc'.repeat(28) });

		await expect(fetchHydraAcknowledgedDeposits(transport)).resolves.toEqual([]);
	});

	it('refuses an answer it cannot read, rather than reporting no deposit', async () => {
		const transport = nodeAnswering({ tag: 'ConfirmedSnapshot', snapshot: { utxoToCommit: 'not-a-map' } });

		await expect(fetchHydraAcknowledgedDeposits(transport)).rejects.toBeInstanceOf(HydraProtocolError);
	});

	// This node has signed it, so the round can still confirm once the other
	// signatures arrive.
	it('reads the deposit a round this node has signed holds', async () => {
		const seen = {
			tag: 'SeenSnapshot',
			snapshot: snapshotBody({ utxoToCommit: { [`${DEPOSIT_TX}#0`]: OUTPUT }, depositTxId: DEPOSIT_TX }),
			signatories: {},
		};

		await expect(fetchHydraAcknowledgedDeposits(nodeAnswering(confirmed(NO_DEPOSIT), seen))).resolves.toEqual([
			DEPOSIT_TX.toLowerCase(),
		]);
	});

	it('reads a round this node has only requested as holding no deposit', async () => {
		const requested = { tag: 'RequestedSnapshot', lastSeen: 7, requested: 8 };

		await expect(fetchHydraAcknowledgedDeposits(nodeAnswering(confirmed(NO_DEPOSIT), requested))).resolves.toEqual([]);
	});

	it.each([
		['a round tag it does not know', { tag: 'FutureSnapshot' }],
		['a signed round without its snapshot', { tag: 'SeenSnapshot', signatories: {} }],
	])('refuses %s, rather than reporting no deposit', async (_label, lastSeen) => {
		await expect(fetchHydraAcknowledgedDeposits(nodeAnswering(confirmed(NO_DEPOSIT), lastSeen))).rejects.toBeInstanceOf(
			HydraProtocolError,
		);
	});
});
