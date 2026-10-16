import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockRelease = jest.fn() as AnyMock;
const mockVerifyFanout = jest.fn() as AnyMock;
const mockGetVerifiedFanoutReferences = jest.fn() as AnyMock;
const mockGetVerifiedFinalOutput = jest.fn() as AnyMock;
const mockGetConfirmedTransaction = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { transaction: { findMany: mockFindMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('./l2-reservation-release', () => ({
	releaseRejectedL2Reservation: mockRelease,
	// Only what the real input-ref fallback in `./l2-reservation-recovery` reads.
	paymentL2ActionRetry: (action: string | undefined) =>
		action === 'SubmitResultInitiated' ? 'SubmitResultRequested' : undefined,
	purchaseL2ActionRetry: () => undefined,
}));

// The real `./l2-reservation-recovery` loads, so its open-head-only imports are stubbed.
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-transaction-evidence', () => ({
	hydraValidityUpperBoundTimeMs: jest.fn(),
}));
jest.unstable_mockModule('@/utils/hydra/l2-slot-context', () => ({
	resolveHydraL2EvidenceSlotConfig: jest.fn(),
}));
jest.unstable_mockModule('@/lib/hydra/hydra/node-control-queries', () => ({
	fetchHydraConfirmedSnapshotNumber: jest.fn(),
}));
jest.unstable_mockModule('./l2-reservation-nudge', () => ({
	nudgeIdleHeadForRelease: jest.fn(),
}));

const { releaseFinalHeadL2Reservations } = await import('./final-l2-reservation-release');

const inputA = `${'a'.repeat(64)}#0`;
const inputB = `${'b'.repeat(64)}#1`;
const fanoutReference = { txHash: 'f'.repeat(64), outputIndex: 0, snapshotNumber: 7, serializedOutput: 'bytes' };

const node = {
	getVerifiedFanoutReferences: mockGetVerifiedFanoutReferences,
	getVerifiedFinalOutput: mockGetVerifiedFinalOutput,
	getConfirmedTransaction: mockGetConfirmedTransaction,
};

function pendingRow(overrides: Record<string, unknown> = {}) {
	return {
		id: 'tx-1',
		intendedTxHash: 'c'.repeat(64),
		l2ReservationInputRefs: [inputA, inputB],
		l2ReleaseNudgeInputRef: null,
		l2ReservationPreviousLayer: null,
		l2ReservationPreviousSmartContractWalletId: null,
		l2ReservationPreviousBuyerReturnAddress: null,
		l2ReservationPreviousCollateralReturn: null,
		l2ReservationPreviousTransactionId: null,
		PaymentRequestCurrent: [],
		PurchaseRequestCurrent: [],
		...overrides,
	};
}

function run() {
	return releaseFinalHeadL2Reservations({
		hydraHeadId: 'head-1',
		expectedSnapshotNumber: 7,
		node: node as never,
		verifyFanoutOnChain: mockVerifyFanout,
	});
}

describe('releaseFinalHeadL2Reservations', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindMany.mockResolvedValue([pendingRow()]);
		mockGetVerifiedFanoutReferences.mockReturnValue([fanoutReference]);
		mockVerifyFanout.mockResolvedValue([]);
		mockGetVerifiedFinalOutput.mockReturnValue('output-bytes');
		mockGetConfirmedTransaction.mockReturnValue(null);
		mockRelease.mockResolvedValue(true);
	});

	it('releases a reservation whose every input the fanned-out final snapshot still holds', async () => {
		await expect(run()).resolves.toBe(1);

		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { hydraHeadId: 'head-1', layer: 'L2', status: 'Pending' } }),
		);
		expect(mockVerifyFanout).toHaveBeenCalledWith([fanoutReference]);
		expect(mockGetVerifiedFinalOutput).toHaveBeenCalledWith(inputA, 7);
		expect(mockGetVerifiedFinalOutput).toHaveBeenCalledWith(inputB, 7);
		expect(mockRelease).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'tx-1', l2ReleaseNudgeInputRef: null }),
			expect.anything(),
			'inputs-unspent-in-final-snapshot',
		);
		expect(mockVerifyFanout.mock.invocationCallOrder[0]).toBeLessThan(mockRelease.mock.invocationCallOrder[0]);
	});

	it('does nothing, not even the chain check, when no L2 row is pending', async () => {
		mockFindMany.mockResolvedValue([]);

		await expect(run()).resolves.toBe(0);
		expect(mockVerifyFanout).not.toHaveBeenCalled();
	});

	it('holds every row when the node cannot bind the fanout to the final snapshot', async () => {
		mockGetVerifiedFanoutReferences.mockReturnValue(null);

		await expect(run()).resolves.toBe(0);
		expect(mockVerifyFanout).not.toHaveBeenCalled();
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('releases nothing when the fanout is not confirmed on chain', async () => {
		mockVerifyFanout.mockRejectedValue(new Error('fanout not confirmed'));

		await expect(run()).rejects.toThrow('fanout not confirmed');
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('holds a reservation with an input the final snapshot no longer holds', async () => {
		mockGetVerifiedFinalOutput.mockImplementation((reference: string) => (reference === inputB ? null : 'bytes'));

		await expect(run()).resolves.toBe(0);
		expect(mockVerifyFanout).not.toHaveBeenCalled();
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('holds a reservation with no known inputs', async () => {
		mockFindMany.mockResolvedValue([pendingRow({ l2ReservationInputRefs: [] })]);

		await expect(run()).resolves.toBe(0);
		expect(mockVerifyFanout).not.toHaveBeenCalled();
		expect(mockRelease).not.toHaveBeenCalled();
	});

	it('leaves a body the history confirmed to ordered replay', async () => {
		mockGetConfirmedTransaction.mockReturnValue({ txId: 'c'.repeat(64) });

		await expect(run()).resolves.toBe(0);
		expect(mockVerifyFanout).not.toHaveBeenCalled();
		expect(mockRelease).not.toHaveBeenCalled();
	});

	// Rows from before inputs were recorded fall back to the request's escrow
	// pointer, which an unconfirmed body has not moved.
	it('releases a row without recorded inputs on its escrow pointer', async () => {
		const pointerTxHash = 'D'.repeat(64);
		mockFindMany.mockResolvedValue([
			pendingRow({
				l2ReservationInputRefs: [],
				l2ReservationPreviousTransactionId: 'previous-tx',
				PaymentRequestCurrent: [
					{
						currentHydraUtxoTxHash: pointerTxHash,
						currentHydraUtxoOutputIndex: 2,
						NextAction: { requestedAction: 'SubmitResultInitiated' },
					},
				],
			}),
		]);

		await expect(run()).resolves.toBe(1);
		expect(mockGetVerifiedFinalOutput).toHaveBeenCalledWith(`${'d'.repeat(64)}#2`, 7);
		expect(mockRelease).toHaveBeenCalledTimes(1);
	});

	it('does not count a release the guarded update refused', async () => {
		mockRelease.mockResolvedValue(false);

		await expect(run()).resolves.toBe(0);
	});
});
