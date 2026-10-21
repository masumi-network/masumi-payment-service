import { describe, expect, it } from '@jest/globals';
import {
	fetchHydraAcknowledgedDeposit,
	fetchHydraPendingDecommitRefs,
	fetchHydraSnapshotRound,
} from './node-control-queries';
import { HydraProtocolError, HydraTransportError } from './errors';
import { HydraHttpResponseError } from './node-frames';

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

	// `/head` carries the snapshot more than once, so a large head can outgrow
	// the byte limit for good. Refusing on that would block every withdrawal
	// and consolidation from it.
	it('clears the guard when the node answered with something it cannot use', async () => {
		const transport = transportThrowing(new HydraProtocolError('Hydra HTTP response exceeded its byte limit'));

		await expect(fetchHydraPendingDecommitRefs(transport)).resolves.toEqual([]);
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

describe('fetchHydraAcknowledgedDeposit', () => {
	const DEPOSIT_TX = 'DD'.repeat(32);
	const OUTPUT = {
		address: 'addr_test1vz',
		value: { lovelace: 5_000_000 },
		referenceScript: null,
		inlineDatum: null,
		inlineDatumRaw: null,
		datum: null,
	};
	const confirmed = (snapshot: Record<string, unknown>) => ({
		tag: 'ConfirmedSnapshot',
		signatures: { multiSignature: [] },
		snapshot: { headId: 'cc'.repeat(28), version: 1, number: 7, confirmed: [], utxo: {}, ...snapshot },
	});

	it('reads the deposit a confirmed snapshot holds, with its id in lowercase', async () => {
		const transport = transportReturning(
			confirmed({ utxoToCommit: { [`${DEPOSIT_TX}#0`]: OUTPUT }, depositTxId: DEPOSIT_TX }),
		);

		await expect(fetchHydraAcknowledgedDeposit(transport)).resolves.toEqual({
			acknowledged: true,
			depositTxId: DEPOSIT_TX.toLowerCase(),
		});
		expect(transport.paths).toEqual(['/snapshot']);
	});

	it.each([
		['null', null],
		['absent', undefined],
		['empty', {}],
	])('reads a snapshot whose utxoToCommit is %s as holding no deposit', async (_label, utxoToCommit) => {
		const transport = transportReturning(confirmed({ utxoToCommit, depositTxId: null }));

		await expect(fetchHydraAcknowledgedDeposit(transport)).resolves.toEqual({ acknowledged: false, depositTxId: null });
	});

	it('reads a head still on its initial snapshot as holding no deposit', async () => {
		const transport = transportReturning({ tag: 'InitialSnapshot', headId: 'cc'.repeat(28) });

		await expect(fetchHydraAcknowledgedDeposit(transport)).resolves.toEqual({ acknowledged: false, depositTxId: null });
	});

	it('refuses an answer it cannot read, rather than reporting no deposit', async () => {
		const transport = transportReturning({ tag: 'ConfirmedSnapshot', snapshot: { utxoToCommit: 'not-a-map' } });

		await expect(fetchHydraAcknowledgedDeposit(transport)).rejects.toBeInstanceOf(HydraProtocolError);
	});
});
