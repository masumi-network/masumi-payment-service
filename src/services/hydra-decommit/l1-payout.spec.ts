import { describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { findDecommitPayoutTx } = await import('./l1-payout');

const ADDRESS = 'addr_test1_local';
const TOKEN = 'a'.repeat(56) + '746f6b656e';

function blockfrostWith(
	txs: Record<string, Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }>>,
) {
	const addressesTransactions = jest.fn() as AnyMock;
	addressesTransactions.mockImplementation((_address: string, options: { page: number }) =>
		Promise.resolve(options.page === 1 ? Object.keys(txs).map((tx_hash) => ({ tx_hash })) : []),
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
});
