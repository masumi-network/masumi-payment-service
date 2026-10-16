import { describe, expect, it } from '@jest/globals';
import { fetchHydraSnapshotRound } from './node-control-queries';
import { HydraProtocolError } from './errors';

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
});
