import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OnChainState, TransactionStatus } from '@/generated/prisma/client';

const mockPaymentRequestFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockPurchaseRequestFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockParseEvidence = jest.fn<(_cborHex: string) => unknown>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentRequest: { findMany: mockPaymentRequestFindMany },
		purchaseRequest: { findMany: mockPurchaseRequestFindMany },
	},
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-transaction-evidence', () => ({
	parseHydraTransactionEvidence: mockParseEvidence,
}));

const {
	findIdentifiersWithNothingToApply,
	isLivePassDue,
	isRowSettledOnOutput,
	memoizedLiveEscrowDecode,
	memoizedTransactionEvidence,
	pruneLiveEscrowMemo,
	recordLivePass,
	retainLiveEscrowMemoHeads,
} = await import('./live-escrow-memo');

const OUTPUT = { txHash: 'tx-live', outputIndex: 0 };
const CANDIDATE = { blockchainIdentifier: 'id-1', newState: OnChainState.ResultSubmitted, outputReference: OUTPUT };

function settledRow(overrides: Record<string, unknown> = {}) {
	return {
		blockchainIdentifier: 'id-1',
		onChainState: OnChainState.ResultSubmitted,
		currentHydraUtxoTxHash: OUTPUT.txHash,
		currentHydraUtxoOutputIndex: OUTPUT.outputIndex,
		currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
		CurrentTransaction: { txHash: OUTPUT.txHash, status: TransactionStatus.Confirmed },
		...overrides,
	};
}

describe('live escrow memo', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		retainLiveEscrowMemoHeads([]);
		mockPaymentRequestFindMany.mockResolvedValue([]);
		mockPurchaseRequestFindMany.mockResolvedValue([]);
		mockParseEvidence.mockImplementation((cborHex) => ({ txHash: cborHex }));
	});

	it('decodes an output reference once per head until it leaves the live set', () => {
		const decode = jest.fn(() => ({ decoded: { blockchainIdentifier: 'id-1' }, newState: OnChainState.FundsLocked }));
		const memoDecode = () => memoizedLiveEscrowDecode('head-1', OUTPUT, 'datum-a', decode as never);

		memoDecode();
		memoDecode();
		expect(decode).toHaveBeenCalledTimes(1);

		pruneLiveEscrowMemo('head-1', []);
		memoDecode();
		expect(decode).toHaveBeenCalledTimes(2);
	});

	it('memoizes an undecodable output as null', () => {
		const decode = jest.fn(() => null);
		expect(memoizedLiveEscrowDecode('head-1', OUTPUT, 'datum-a', decode)).toBeNull();
		expect(memoizedLiveEscrowDecode('head-1', OUTPUT, 'datum-a', decode)).toBeNull();
		expect(decode).toHaveBeenCalledTimes(1);
	});

	it('re-decodes an output reference when its datum bytes differ', () => {
		const decode = jest.fn(() => null);
		memoizedLiveEscrowDecode('head-1', OUTPUT, 'datum-a', decode);
		memoizedLiveEscrowDecode('head-1', OUTPUT, 'datum-b', decode);
		expect(decode).toHaveBeenCalledTimes(2);
	});

	it('keeps a live pass due until a clean pass, then throttles for the interval', () => {
		expect(isLivePassDue('head-1', 60_000, 1_000)).toBe(true);
		recordLivePass('head-1', false, 1_000);
		expect(isLivePassDue('head-1', 60_000, 2_000)).toBe(true);
		recordLivePass('head-1', true, 2_000);
		expect(isLivePassDue('head-1', 60_000, 61_999)).toBe(false);
		expect(isLivePassDue('head-1', 60_000, 62_000)).toBe(true);
		recordLivePass('head-1', false, 62_000);
		expect(isLivePassDue('head-1', 60_000, 62_001)).toBe(true);
	});

	it('forgets the throttle window of a head that is no longer reconciled', () => {
		recordLivePass('head-1', true, 1_000);
		retainLiveEscrowMemoHeads([]);
		expect(isLivePassDue('head-1', 60_000, 1_001)).toBe(true);
	});

	it('re-parses evidence when the CBOR for a tx hash changes, and after the head is dropped', () => {
		memoizedTransactionEvidence('head-1', 'tx-live', 'cbor-a');
		memoizedTransactionEvidence('head-1', 'tx-live', 'cbor-a');
		expect(mockParseEvidence).toHaveBeenCalledTimes(1);

		memoizedTransactionEvidence('head-1', 'tx-live', 'cbor-b');
		expect(mockParseEvidence).toHaveBeenCalledTimes(2);

		retainLiveEscrowMemoHeads(['head-2']);
		memoizedTransactionEvidence('head-1', 'tx-live', 'cbor-b');
		expect(mockParseEvidence).toHaveBeenCalledTimes(3);
	});

	it.each([
		['state differs', { onChainState: OnChainState.FundsLocked }],
		['row points at an older output', { currentHydraUtxoTxHash: 'tx-old' }],
		['output index differs', { currentHydraUtxoOutputIndex: 1 }],
		['value not persisted', { currentHydraUtxoValue: null }],
		['transaction pending', { CurrentTransaction: { txHash: OUTPUT.txHash, status: TransactionStatus.Pending } }],
		['transaction is another tx', { CurrentTransaction: { txHash: 'tx-old', status: TransactionStatus.Confirmed } }],
		['no current transaction', { CurrentTransaction: null }],
	])('treats a row as unsettled when %s', (_label, overrides) => {
		expect(isRowSettledOnOutput(settledRow(overrides) as never, CANDIDATE)).toBe(false);
	});

	it('treats a row on the exact output with a confirmed tx and same state as settled', () => {
		expect(isRowSettledOnOutput(settledRow() as never, CANDIDATE)).toBe(true);
	});

	it('returns identifiers with no local row or only settled rows, scoped to the payment source', async () => {
		const candidates = [
			CANDIDATE,
			{ ...CANDIDATE, blockchainIdentifier: 'id-foreign' },
			{ ...CANDIDATE, blockchainIdentifier: 'id-open' },
		];
		mockPaymentRequestFindMany.mockResolvedValue([settledRow(), settledRow({ blockchainIdentifier: 'id-open' })]);
		mockPurchaseRequestFindMany.mockResolvedValue([
			settledRow({ blockchainIdentifier: 'id-open', onChainState: OnChainState.FundsLocked }),
		]);

		const result = await findIdentifiersWithNothingToApply('source-1', candidates);

		expect(result).toEqual(new Set(['id-1', 'id-foreign']));
		expect(mockPaymentRequestFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { paymentSourceId: 'source-1', blockchainIdentifier: { in: ['id-1', 'id-foreign', 'id-open'] } },
			}),
		);
	});

	it('skips the query when there are no candidates', async () => {
		expect(await findIdentifiersWithNothingToApply('source-1', [])).toEqual(new Set());
		expect(mockPaymentRequestFindMany).not.toHaveBeenCalled();
	});
});
