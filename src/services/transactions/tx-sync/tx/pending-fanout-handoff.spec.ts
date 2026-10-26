import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus, TransactionLayer } from '@/generated/prisma/client';

const mockFindHead = jest.fn<
	(_query: unknown) => Promise<{
		status: HydraHeadStatus;
		headIdentifier: string;
		LocalParticipant: { cardanoVkey: string } | null;
		RemoteParticipants: Array<{ cardanoVkey: string }>;
	} | null>
>();
const mockIsBoundOrigin = jest.fn<(_options: unknown) => Promise<boolean>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { findUnique: mockFindHead } },
}));
jest.unstable_mockModule('@/lib/hydra/hydra/fanout-output-origin', () => ({
	isBoundFanoutOutputOrigin: mockIsBoundOrigin,
}));

const { deferSpendUntilFanoutHandoff, PendingFanoutHandoffError } = await import('./pending-fanout-handoff');
const l2Request = {
	layer: TransactionLayer.L2,
	CurrentTransaction: { layer: TransactionLayer.L2, hydraHeadId: 'head-1' },
};
const input = { tx_hash: 'a'.repeat(64), output_index: 1, amount: [{ unit: 'lovelace', quantity: '10000000' }] };
const run = (candidate: Parameters<typeof deferSpendUntilFanoutHandoff>[0]) =>
	deferSpendUntilFanoutHandoff(candidate, input, 'addr_test1_contract', {} as never);

beforeEach(() => {
	mockFindHead.mockReset();
	mockIsBoundOrigin.mockReset();
	mockIsBoundOrigin.mockResolvedValue(true);
});

describe('a confirmed L1 spend before final fanout handoff', () => {
	it.each([
		{ LocalParticipant: null, RemoteParticipants: [{ cardanoVkey: 'd'.repeat(56) }] },
		{ LocalParticipant: { cardanoVkey: 'c'.repeat(56) }, RemoteParticipants: [] },
		{
			LocalParticipant: { cardanoVkey: 'c'.repeat(56) },
			RemoteParticipants: [{ cardanoVkey: 'd'.repeat(56) }, { cardanoVkey: 'e'.repeat(56) }],
		},
	])('defers when participant identity is incomplete: %j', async (participants) => {
		mockFindHead.mockResolvedValue({
			status: HydraHeadStatus.FanningOut,
			headIdentifier: 'b'.repeat(56),
			...participants,
		});
		mockIsBoundOrigin.mockResolvedValue(false);
		await expect(run(l2Request)).rejects.toBeInstanceOf(PendingFanoutHandoffError);
		expect(mockIsBoundOrigin).not.toHaveBeenCalled();
	});

	it.each([HydraHeadStatus.Open, HydraHeadStatus.FanningOut, HydraHeadStatus.Final])(
		'holds a proven fanout spend even when the stored head status is %s',
		async (status) => {
			mockFindHead.mockResolvedValue({
				status,
				headIdentifier: 'b'.repeat(56),
				LocalParticipant: { cardanoVkey: 'c'.repeat(56) },
				RemoteParticipants: [{ cardanoVkey: 'd'.repeat(56) }],
			});
			await expect(run(l2Request)).rejects.toBeInstanceOf(PendingFanoutHandoffError);
			expect(mockFindHead).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'head-1' } }));
			expect(mockIsBoundOrigin).toHaveBeenCalledWith(expect.objectContaining({ producerTxHash: input.tx_hash }));
		},
	);

	it('allows an unrelated producer while the head is Open', async () => {
		mockFindHead.mockResolvedValue({
			status: HydraHeadStatus.Open,
			headIdentifier: 'b'.repeat(56),
			LocalParticipant: { cardanoVkey: 'c'.repeat(56) },
			RemoteParticipants: [{ cardanoVkey: 'd'.repeat(56) }],
		});
		mockIsBoundOrigin.mockResolvedValue(false);
		await expect(run(l2Request)).resolves.toBeUndefined();
		expect(mockIsBoundOrigin).toHaveBeenCalled();
	});

	it('stops deferring after the atomic handoff moves the request to L1', async () => {
		await expect(run({ ...l2Request, layer: TransactionLayer.L1 })).resolves.toBeUndefined();
		expect(mockFindHead).not.toHaveBeenCalled();
	});

	it('does not let an unrelated contract output hold the source queue', async () => {
		mockFindHead.mockResolvedValue({
			status: HydraHeadStatus.FanningOut,
			headIdentifier: 'b'.repeat(56),
			LocalParticipant: { cardanoVkey: 'c'.repeat(56) },
			RemoteParticipants: [{ cardanoVkey: 'd'.repeat(56) }],
		});
		mockIsBoundOrigin.mockResolvedValue(false);
		await expect(run(l2Request)).resolves.toBeUndefined();
	});
});
