import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	Address,
	BigNum,
	PlutusData,
	Transaction,
	TransactionBody,
	TransactionHash,
	TransactionInput,
	TransactionInputs,
	TransactionOutput,
	TransactionOutputs,
	TransactionWitnessSet,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';

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
}));

const { releaseFinalHeadL2Reservations } = await import('./final-l2-reservation-release');
const { encodeL2ReleaseNudgeDatum, readL2ReleaseNudgeProof } = await import('./l2-release-nudge-proof');

const inputA = `${'a'.repeat(64)}#0`;
const inputB = `${'b'.repeat(64)}#1`;

function nudgeTxOver(inputs: string[]): string {
	const txInputs = TransactionInputs.new();
	for (const reference of inputs) {
		const [txHash, index] = reference.split('#');
		txInputs.add(TransactionInput.new(TransactionHash.from_hex(txHash), Number(index)));
	}
	const output = TransactionOutput.new(
		Address.from_bech32(
			'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd',
		),
		Value.new(BigNum.from_str('10000000')),
	);
	output.set_plutus_data(PlutusData.from_hex(encodeL2ReleaseNudgeDatum(new Uint8Array(32).fill(3))));
	const outputs = TransactionOutputs.new();
	outputs.add(output);
	return Transaction.new(
		TransactionBody.new_tx_body(txInputs, outputs, BigNum.zero()),
		TransactionWitnessSet.new(),
	).to_hex();
}

const nudgeTx = nudgeTxOver([inputA, inputB]);
const proof = readL2ReleaseNudgeProof(nudgeTx, [inputA, inputB]);
if (!proof) throw new Error('fixture nudge must pass the proof');
/** The final snapshot holds the nudge output, and nothing at any other reference. */
const finalOutputWithNudge = (reference: string) => (reference === proof.reference ? proof.serializedOutput : null);
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
		l2ReleaseNudgeTx: nudgeTx,
		l2ReservationPreviousLayer: null,
		l2ReservationPreviousSmartContractWalletId: null,
		l2ReservationPreviousBuyerReturnAddress: null,
		l2ReservationPreviousCollateralReturn: null,
		l2ReservationPreviousTransactionId: null,
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
		mockGetVerifiedFinalOutput.mockImplementation(finalOutputWithNudge);
		mockGetConfirmedTransaction.mockReturnValue(null);
		mockRelease.mockResolvedValue(true);
	});

	it('releases a reservation whose nudge output the fanned-out final snapshot holds', async () => {
		await expect(run()).resolves.toBe(1);

		expect(mockFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { hydraHeadId: 'head-1', layer: 'L2', status: 'Pending' } }),
		);
		expect(mockVerifyFanout).toHaveBeenCalledWith([fanoutReference]);
		expect(mockGetVerifiedFinalOutput).toHaveBeenCalledWith(proof.reference, 7);
		expect(mockRelease).toHaveBeenCalledWith(
			expect.objectContaining({ id: 'tx-1', l2ReleaseNudgeTx: nudgeTx }),
			expect.anything(),
			'spent-by-release-nudge',
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

	// The reported finding on a Final head: every input reads as unspent in
	// the final snapshot, which a forged reference mapping can arrange. The
	// reference proof released here.
	it('holds a reservation whose inputs only read as unspent', async () => {
		mockGetVerifiedFinalOutput.mockImplementation((reference: string) =>
			reference === inputA || reference === inputB ? 'twin-output-bytes' : null,
		);

		await expect(run()).resolves.toBe(0);
		expect(mockVerifyFanout).not.toHaveBeenCalled();
		expect(mockRelease).not.toHaveBeenCalled();
	});

	// A Final head takes no new transaction, so a nudge that never applied
	// before the close can never prove the row dead.
	it('holds a reservation that was never nudged', async () => {
		mockFindMany.mockResolvedValue([pendingRow({ l2ReleaseNudgeTx: null })]);

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

	it('does not count a release the guarded update refused', async () => {
		mockRelease.mockResolvedValue(false);

		await expect(run()).resolves.toBe(0);
	});
});
