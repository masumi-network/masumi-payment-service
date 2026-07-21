import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockAdvancedRetryAll = jest.fn() as AnyMock;
const mockDelayErrorResolver = jest.fn(() => ({}));
const mockLoggerError = jest.fn();

jest.unstable_mockModule('advanced-retry', () => ({
	advancedRetryAll: mockAdvancedRetryAll,
	delayErrorResolver: mockDelayErrorResolver,
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: mockLoggerError,
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@emurgo/cardano-serialization-lib-nodejs', () => ({
	Transaction: { from_bytes: jest.fn(() => ({})) },
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 1 },
	CONSTANTS: { MAX_DEFAULT_SMART_CONTRACT_HISTORY_LEVELS: 10 },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {},
}));

let getExtendedTxInformation!: typeof import('./index').getExtendedTxInformation;

beforeAll(async () => {
	({ getExtendedTxInformation } = await import('./index'));
});

beforeEach(() => {
	jest.clearAllMocks();
});

function enumeratedTx(txHash: string, blockHeight: number, txIndex: number, blockTime = 1_784_614_225) {
	return { tx_hash: txHash, block_time: blockTime, block_height: blockHeight, tx_index: txIndex };
}

function fetchedTx(txHash: string, blockHeight: number, txIndex: number, blockTime = 1_784_614_225) {
	return {
		success: true as const,
		result: {
			tx: { tx_hash: txHash },
			block: { confirmations: 10 },
			metadata: {},
			utxos: {},
			transaction: {},
			blockTime,
			blockHeight,
			txIndex,
		},
	};
}

describe('getExtendedTxInformation', () => {
	// This previously threw, halting the sync so the checkpoint could not
	// advance. That prevented silent data loss but introduced head-of-line
	// blocking: a transaction that can never be fetched — one rolled back
	// mid-flight, say — stalled every later transaction for that payment source
	// indefinitely. Failures are now reported so the caller can quarantine them
	// durably and still make progress.
	it('reports failed lookups instead of throwing or dropping them', async () => {
		mockAdvancedRetryAll.mockResolvedValueOnce([{ success: false, error: new Error('blockfrost timeout') }]);

		const { txData, failures } = await getExtendedTxInformation(
			[enumeratedTx('funds-lock-tx', 13705455, 5)],
			{} as never,
			1,
		);

		expect(txData).toHaveLength(0);
		expect(failures).toEqual([
			{
				txHash: 'funds-lock-tx',
				blockHeight: 13705455,
				txIndex: 5,
				error: expect.any(Error),
			},
		]);
		expect(mockLoggerError).toHaveBeenCalledWith(
			expect.stringContaining('quarantining'),
			expect.objectContaining({ txHashes: ['funds-lock-tx'] }),
		);
	});

	it('returns the successful txs alongside the failed ones', async () => {
		mockAdvancedRetryAll.mockResolvedValueOnce([
			fetchedTx('ok-tx', 13705455, 3),
			{ success: false, error: new Error('blockfrost 429') },
		]);

		const { txData, failures } = await getExtendedTxInformation(
			[enumeratedTx('ok-tx', 13705455, 3), enumeratedTx('bad-tx', 13705455, 5)],
			{} as never,
			2,
		);

		expect(txData.map((x) => x.tx.tx_hash)).toEqual(['ok-tx']);
		expect(failures.map((x) => x.txHash)).toEqual(['bad-tx']);
	});

	// Every tx in a block shares block_time, so sorting on it alone leaves
	// same-block ordering undefined. The checkpoint advances per tx, so
	// processing out of chain order can move it past an unprocessed tx.
	it('orders transactions by chain position, not just block time', async () => {
		mockAdvancedRetryAll.mockResolvedValueOnce([
			fetchedTx('block-b-idx-0', 13705460, 0),
			fetchedTx('block-a-idx-5', 13705455, 5),
			fetchedTx('block-a-idx-3', 13705455, 3),
		]);

		const { txData } = await getExtendedTxInformation(
			[
				enumeratedTx('block-b-idx-0', 13705460, 0),
				enumeratedTx('block-a-idx-5', 13705455, 5),
				enumeratedTx('block-a-idx-3', 13705455, 3),
			],
			{} as never,
			3,
		);

		expect(txData.map((x) => x.tx.tx_hash)).toEqual(['block-a-idx-3', 'block-a-idx-5', 'block-b-idx-0']);
	});

	// The exact shape of the production incident: three txs in block 13705455,
	// indices 3, 4 and 5. Ordering by block_time alone cannot distinguish them.
	it('orders by tx_index within a single block even when block_time is identical', async () => {
		const sharedBlockTime = 1_784_614_225;
		mockAdvancedRetryAll.mockResolvedValueOnce([
			fetchedTx('idx-5', 13705455, 5, sharedBlockTime),
			fetchedTx('idx-3', 13705455, 3, sharedBlockTime),
			fetchedTx('idx-4', 13705455, 4, sharedBlockTime),
		]);

		const { txData } = await getExtendedTxInformation(
			[
				enumeratedTx('idx-5', 13705455, 5, sharedBlockTime),
				enumeratedTx('idx-3', 13705455, 3, sharedBlockTime),
				enumeratedTx('idx-4', 13705455, 4, sharedBlockTime),
			],
			{} as never,
			3,
		);

		expect(txData.map((x) => x.tx.tx_hash)).toEqual(['idx-3', 'idx-4', 'idx-5']);
	});

	// Exercises the REAL per-tx fetch closure (the mock below executes the
	// operations instead of stubbing their results). The quarantine reconciler
	// calls this function with stub enumeration values because it only has a
	// txHash — blockTime feeds the pay-by-time timeout check in the tx handlers,
	// so it must come from the fetched details, never from the caller's input.
	it('takes blockTime and chain position from the fetched details, not the enumeration input', async () => {
		mockAdvancedRetryAll.mockImplementationOnce(
			async ({ operations }: { operations: Array<() => Promise<unknown>> }) => {
				return await Promise.all(operations.map(async (operation) => ({ success: true, result: await operation() })));
			},
		);

		const blockfrost = {
			txs: jest.fn(async () => ({
				block: 'block-hash',
				fees: '1000',
				block_height: 13705455,
				block_time: 1_784_614_225,
				index: 5,
				output_amount: [],
				utxo_count: 5,
				withdrawal_count: 0,
				asset_mint_or_burn_count: 0,
				redeemer_count: 1,
				valid_contract: true,
			})),
			blocks: jest.fn(async () => ({ confirmations: 10 })),
			txsCbor: jest.fn(async () => ({ cbor: 'aa' })),
			txsUtxos: jest.fn(async () => ({ inputs: [], outputs: [] })),
		};

		// Deliberately wrong stub values, as the reconciler supplies them.
		const { txData } = await getExtendedTxInformation(
			[{ tx_hash: 'quarantined-tx', block_time: 0, block_height: 0, tx_index: 0 }],
			blockfrost as never,
			1,
		);

		expect(txData).toHaveLength(1);
		expect(txData[0].blockTime).toBe(1_784_614_225);
		expect(txData[0].blockHeight).toBe(13705455);
		expect(txData[0].txIndex).toBe(5);
	});
});
