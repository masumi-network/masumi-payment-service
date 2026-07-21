import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { IFetcher, UTxO } from '@meshsdk/core';

// `@/utils/logger` transitively loads `@/utils/config`, which throws without a
// DATABASE_URL. The guard's logging is incidental to what these tests assert.
jest.unstable_mockModule('@/utils/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { assertEscrowUtxoUnspent, clearEscrowUtxoCache } = await import('./escrow-utxo');

const SMART_CONTRACT_ADDRESS = 'addr_test1_contract';
const NOW_MS = 1_700_000_000_000;

function buildUtxo(txHash: string, outputIndex: number): UTxO {
	return {
		input: { txHash, outputIndex },
		output: { address: SMART_CONTRACT_ADDRESS, amount: [{ unit: 'lovelace', quantity: '10000000' }] },
	} as UTxO;
}

function buildFetcher(liveUtxos: UTxO[]): { fetcher: IFetcher; callCount: () => number } {
	let calls = 0;
	const fetcher = {
		fetchAddressUTxOs: () => {
			calls += 1;
			return Promise.resolve(liveUtxos);
		},
	} as unknown as IFetcher;
	return { fetcher, callCount: () => calls };
}

/** Returns a different set per call, so a stale snapshot can be simulated. */
function buildSequenceFetcher(sets: UTxO[][]): { fetcher: IFetcher; callCount: () => number } {
	let calls = 0;
	const fetcher = {
		fetchAddressUTxOs: () => {
			const set = sets[Math.min(calls, sets.length - 1)];
			calls += 1;
			return Promise.resolve(set);
		},
	} as unknown as IFetcher;
	return { fetcher, callCount: () => calls };
}

describe('assertEscrowUtxoUnspent', () => {
	beforeEach(() => {
		clearEscrowUtxoCache();
	});

	it('resolves when the escrow UTxO is still in the address UTxO set', async () => {
		const utxo = buildUtxo('aa', 1);
		const { fetcher } = buildFetcher([buildUtxo('bb', 0), utxo]);

		await expect(assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS)).resolves.toBeUndefined();
	});

	it('throws when the address set is non-empty but does not contain the escrow UTxO', async () => {
		const utxo = buildUtxo('aa', 1);
		const { fetcher } = buildFetcher([buildUtxo('bb', 0)]);

		await expect(assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS)).rejects.toThrow(
			'already spent',
		);
	});

	it('throws when only the output index differs', async () => {
		const utxo = buildUtxo('aa', 1);
		const { fetcher } = buildFetcher([buildUtxo('aa', 0)]);

		await expect(assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS)).rejects.toThrow(
			'already spent',
		);
	});

	// Mesh's BlockfrostProvider.fetchAddressUTxOs ends in `catch { return [] }`,
	// so an empty set is indistinguishable from a 429/5xx/timeout. Concluding
	// "spent" here would park legitimate requests in WaitingForManualAction on
	// any transient Blockfrost failure.
	it('does NOT conclude spent when the address returns an empty set', async () => {
		const utxo = buildUtxo('aa', 1);
		const { fetcher } = buildFetcher([]);

		await expect(assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS)).resolves.toBeUndefined();
	});

	it('reuses a positive address fetch within the cache window', async () => {
		const utxo = buildUtxo('aa', 1);
		const { fetcher, callCount } = buildFetcher([utxo]);

		await assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS);
		await assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS + 1_000);

		expect(callCount()).toBe(1);
	});

	it('refetches once the cache window has elapsed', async () => {
		const utxo = buildUtxo('aa', 1);
		const { fetcher, callCount } = buildFetcher([utxo]);

		await assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS);
		await assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS + 20_000);

		expect(callCount()).toBe(2);
	});

	it('never caches an empty (ambiguous) result', async () => {
		const utxo = buildUtxo('aa', 1);
		const { fetcher, callCount } = buildFetcher([]);

		await assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS);
		await assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, utxo, NOW_MS + 1_000);

		expect(callCount()).toBe(2);
	});

	// A cached snapshot omits every UTxO created AFTER it was taken. A
	// just-confirmed continuation output is exactly that, so concluding 'spent'
	// from a cached set would park a live request in WaitingForManualAction.
	it('refetches instead of concluding spent when the UTxO is missing from a cached set', async () => {
		const older = buildUtxo('older', 0);
		const justCreated = buildUtxo('just-created', 0);
		// call 1: snapshot without the new UTxO. call 2 (refetch): it is there.
		const { fetcher, callCount } = buildSequenceFetcher([[older], [older, justCreated]]);

		// warm the cache with the stale snapshot
		await assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, older, NOW_MS);
		expect(callCount()).toBe(1);

		await expect(
			assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, justCreated, NOW_MS + 1_000),
		).resolves.toBeUndefined();
		expect(callCount()).toBe(2);
	});

	it('still throws when the UTxO is absent from a freshly fetched set', async () => {
		const other = buildUtxo('other', 0);
		const spent = buildUtxo('spent', 0);
		const { fetcher, callCount } = buildSequenceFetcher([[other], [other]]);

		await expect(assertEscrowUtxoUnspent(fetcher, SMART_CONTRACT_ADDRESS, spent, NOW_MS)).rejects.toThrow(
			'already spent',
		);
		// one initial fetch plus the confirming refetch
		expect(callCount()).toBe(2);
	});
});
