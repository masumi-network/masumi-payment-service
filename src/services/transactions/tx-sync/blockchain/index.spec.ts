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

let getExtendedTxInformation!: typeof import('./index').getExtendedTxInformation;

beforeAll(async () => {
	({ getExtendedTxInformation } = await import('./index'));
});

beforeEach(() => {
	jest.clearAllMocks();
});

describe('getExtendedTxInformation', () => {
	it('halts instead of dropping txs whose extended lookup failed', async () => {
		mockAdvancedRetryAll.mockResolvedValueOnce([{ success: false, error: new Error('blockfrost timeout') }]);

		await expect(
			getExtendedTxInformation([{ tx_hash: 'funds-lock-tx', block_time: 123 }], {} as never, 1),
		).rejects.toThrow('Failed to get extended data for 1 transaction(s): funds-lock-tx');

		expect(mockLoggerError).toHaveBeenCalledWith(
			'Failed to get extended data for transactions; halting tx-sync checkpoint advance',
			expect.objectContaining({
				txHashes: ['funds-lock-tx'],
			}),
		);
	});
});
