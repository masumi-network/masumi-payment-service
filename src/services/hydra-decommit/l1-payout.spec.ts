import { describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { findDecommitPayoutTx, decommitPayoutSearchBounds } = await import('./l1-payout');

const ADDRESS = 'addr_test1_local';
const TOKEN = 'a'.repeat(56) + '746f6b656e';

function blockfrostWith(
	txs: Record<string, Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }>>,
	blockTimes: Record<string, number> = {},
) {
	const addressesTransactions = jest.fn() as AnyMock;
	addressesTransactions.mockImplementation((_address: string, options: { page: number }) =>
		Promise.resolve(
			options.page === 1 ? Object.keys(txs).map((tx_hash) => ({ tx_hash, block_time: blockTimes[tx_hash] ?? 0 })) : [],
		),
	);
	const txsUtxos = jest.fn() as AnyMock;
	txsUtxos.mockImplementation((hash: string) => Promise.resolve({ outputs: txs[hash] ?? [] }));
	return { addressesTransactions, txsUtxos } as never;
}

describe('findDecommitPayoutTx', () => {
	it('finds the transaction whose output is exactly what left the head', async () => {
		const blockfrost = blockfrostWith({
			decoy: [{ address: ADDRESS, amount: [{ unit: 'lovelace', quantity: '9999999' }] }],
			payout: [
				{
					address: ADDRESS,
					amount: [
						{ unit: 'lovelace', quantity: '4829879' },
						{ unit: TOKEN, quantity: '1' },
					],
				},
			],
		});

		const found = await findDecommitPayoutTx({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 4_829_879n, assets: { [TOKEN]: '1' } },
		});

		expect(found).toBe('payout');
	});

	// The units come from two different sources — the head's own report and
	// Blockfrost — and nothing guarantees they agree on hex casing.
	it('matches units that differ only in case', async () => {
		const blockfrost = blockfrostWith({
			payout: [
				{
					address: ADDRESS,
					amount: [
						{ unit: 'lovelace', quantity: '2000000' },
						{ unit: TOKEN.toUpperCase(), quantity: '5' },
					],
				},
			],
		});

		const found = await findDecommitPayoutTx({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 2_000_000n, assets: { [TOKEN]: '5' } },
		});

		expect(found).toBe('payout');
	});

	// An output carrying the same token plus something else is a different
	// payment, not this withdrawal.
	it('refuses an output that carries more than what left the head', async () => {
		const blockfrost = blockfrostWith({
			other: [
				{
					address: ADDRESS,
					amount: [
						{ unit: 'lovelace', quantity: '4829879' },
						{ unit: TOKEN, quantity: '1' },
						{ unit: 'b'.repeat(56), quantity: '1' },
					],
				},
			],
		});

		const found = await findDecommitPayoutTx({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 4_829_879n, assets: { [TOKEN]: '1' } },
		});

		expect(found).toBeNull();
	});

	// A payout that has not been seen yet is not a failure: the withdrawal is
	// still settled, it just has no link on it.
	it('returns null rather than throwing when nothing matches', async () => {
		const found = await findDecommitPayoutTx({
			blockfrost: blockfrostWith({}),
			address: ADDRESS,
			expected: { lovelace: 1n, assets: {} },
		});

		expect(found).toBeNull();
	});

	// Defect H: several identical-amount withdrawals minutes apart all match on
	// value, so the search must land on the one closest after this withdrawal's
	// own approval rather than whichever is newest on chain.
	it('prefers the oldest matching payout at or after notBefore', async () => {
		const t1 = 1_000;
		const t2 = 2_000;
		const t3 = 3_000;
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		// History arrives newest-first, as Blockfrost returns it with `order: 'desc'`.
		const blockfrost = blockfrostWith(
			{
				p3: [{ address: ADDRESS, amount }],
				p2: [{ address: ADDRESS, amount }],
				p1: [{ address: ADDRESS, amount }],
			},
			{ p3: t3, p2: t2, p1: t1 },
		);

		const found = await findDecommitPayoutTx({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
			notBefore: new Date(((t1 + t2) / 2) * 1000),
		});

		expect(found).toBe('p2');
	});

	it('skips a transaction already attributed to another withdrawal', async () => {
		const t1 = 1_000;
		const t2 = 2_000;
		const t3 = 3_000;
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const blockfrost = blockfrostWith(
			{
				p3: [{ address: ADDRESS, amount }],
				p2: [{ address: ADDRESS, amount }],
				p1: [{ address: ADDRESS, amount }],
			},
			{ p3: t3, p2: t2, p1: t1 },
		);

		const found = await findDecommitPayoutTx({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
			notBefore: new Date(((t1 + t2) / 2) * 1000),
			exclude: new Set(['p2']),
		});

		expect(found).toBe('p3');
	});

	// A match already in hand from an earlier page must survive a later page's
	// read failure: the loop now walks on past the first match (to find the
	// OLDEST one), so a failure on page 2 must not throw away what page 1 found.
	it('keeps a match found on page 1 when page 2 fails to load', async () => {
		const amount = [{ unit: 'lovelace', quantity: '3500000' }];
		const addressesTransactions = jest.fn() as AnyMock;
		addressesTransactions.mockImplementation((_address: string, options: { page: number }) => {
			if (options.page === 1) return Promise.resolve([{ tx_hash: 'payout', block_time: 1_000 }]);
			return Promise.reject(new Error('blockfrost unavailable'));
		});
		const txsUtxos = jest.fn() as AnyMock;
		txsUtxos.mockImplementation((hash: string) =>
			Promise.resolve({ outputs: hash === 'payout' ? [{ address: ADDRESS, amount }] : [] }),
		);
		const blockfrost = { addressesTransactions, txsUtxos } as never;

		const found = await findDecommitPayoutTx({
			blockfrost,
			address: ADDRESS,
			expected: { lovelace: 3_500_000n, assets: {} },
		});

		expect(found).toBe('payout');
	});
});

describe('decommitPayoutSearchBounds', () => {
	// The RED case for the payout-lookup bug: settle.ts backfills `approvedAt`
	// to "now" when a decommit finalizes without ever having observed an
	// Approved event (a restart, a replay starting mid-history, a missed
	// frame). A bound taken from that backfilled timestamp lands AFTER the
	// payout's own block_time, so `findDecommitPayoutTx` would exclude the
	// genuine match on every call, including the retry pass, and `l1TxId`
	// would never be set. The bound must always come from `createdAt`, which
	// is written before the decommit is even built and so is always earlier
	// than the payout that follows it.
	it('bounds the search at createdAt even when approvedAt was backfilled later than the payout', () => {
		const createdAt = new Date('2026-01-01T00:00:00.000Z');
		const approvedAt = new Date('2026-01-01T00:10:00.000Z');

		const bounds = decommitPayoutSearchBounds({ createdAt, approvedAt }, []);

		expect(bounds.notBefore).toEqual(createdAt);
	});

	it('excludes sibling payout hashes and ignores null ones', () => {
		const createdAt = new Date('2026-01-01T00:00:00.000Z');

		const bounds = decommitPayoutSearchBounds({ createdAt, approvedAt: null }, [
			{ l1TxId: 'sibling-1' },
			{ l1TxId: null },
			{ l1TxId: 'sibling-2' },
		]);

		expect(bounds.exclude).toEqual(new Set(['sibling-1', 'sibling-2']));
	});
});
