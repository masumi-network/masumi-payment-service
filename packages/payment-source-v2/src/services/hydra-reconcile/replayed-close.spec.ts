import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { ClosedHeadFacts } from '@/lib/hydra/hydra/head-output-tx';

const mockHydraHeadUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockFetchClosedHeadFacts = jest.fn<() => Promise<ClosedHeadFacts | undefined>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { updateMany: mockHydraHeadUpdateMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { recordReplayedCloseSnapshot } = await import('./replayed-close');

const CONTEST_DEADLINE = '2026-10-22T12:30:00Z';

function nodeWith(status: HydraHeadStatus, closedSnapshotNumber: bigint | undefined) {
	return { status, closedSnapshotNumber, fetchClosedHeadFacts: mockFetchClosedHeadFacts };
}

describe('recordReplayedCloseSnapshot', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 1 });
		mockFetchClosedHeadFacts.mockResolvedValue({ contestationDeadline: CONTEST_DEADLINE });
	});

	it('raises the row of a live Closed head and moves its deadline to a later time', async () => {
		await expect(recordReplayedCloseSnapshot('head-1', 3n, nodeWith(HydraHeadStatus.Closed, 5n))).resolves.toBe(true);

		// The deadline first: the raise ends the trigger, so a deadline written after it
		// would never be tried again.
		const [deadlineWrite, raise] = mockHydraHeadUpdateMany.mock.calls.map(([args]) => args);
		expect(deadlineWrite).toMatchObject({
			where: {
				id: 'head-1',
				isEnabled: true,
				status: HydraHeadStatus.Closed,
				OR: [{ contestationDeadline: null }, { contestationDeadline: { lt: new Date(CONTEST_DEADLINE) } }],
			},
			data: { contestationDeadline: new Date(CONTEST_DEADLINE) },
		});
		expect(raise).toMatchObject({
			where: {
				id: 'head-1',
				isEnabled: true,
				status: {
					in: [
						HydraHeadStatus.Closed,
						HydraHeadStatus.FanoutPossible,
						HydraHeadStatus.FanningOut,
						HydraHeadStatus.Final,
					],
				},
				reconciliationCompletedAt: null,
				latestSnapshotNumber: { lt: 5n },
			},
			data: { latestSnapshotNumber: 5n },
		});
	});

	it.each([HydraHeadStatus.FanoutPossible, HydraHeadStatus.FanningOut, HydraHeadStatus.Final])(
		'raises the row of a live %s head without asking the node for a deadline',
		async (status) => {
			await expect(recordReplayedCloseSnapshot('head-1', 3n, nodeWith(status, 5n))).resolves.toBe(true);

			expect(mockFetchClosedHeadFacts).not.toHaveBeenCalled();
			expect(mockHydraHeadUpdateMany).toHaveBeenCalledTimes(1);
			expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({ data: { latestSnapshotNumber: 5n } }),
			);
		},
	);

	it('writes nothing when the row already holds the closed snapshot', async () => {
		await expect(recordReplayedCloseSnapshot('head-1', 5n, nodeWith(HydraHeadStatus.Closed, 5n))).resolves.toBe(false);

		expect(mockFetchClosedHeadFacts).not.toHaveBeenCalled();
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
	});

	it('writes nothing when the live head is open again', async () => {
		// A chain rollback undid the close, but this pass's history still holds it.
		await expect(recordReplayedCloseSnapshot('head-1', 3n, nodeWith(HydraHeadStatus.Open, 5n))).resolves.toBe(false);

		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
	});

	it('still raises the snapshot when the node reports an unparseable deadline', async () => {
		mockFetchClosedHeadFacts.mockResolvedValue({ contestationDeadline: 'not a date' });

		await expect(recordReplayedCloseSnapshot('head-1', 3n, nodeWith(HydraHeadStatus.Closed, 5n))).resolves.toBe(true);

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { latestSnapshotNumber: 5n } }),
		);
	});

	it('holds the raise of a live Closed head until the node returns its head state', async () => {
		// The raise ends the trigger, so raising here would lose the contest's deadline.
		mockFetchClosedHeadFacts.mockResolvedValue(undefined);

		await expect(recordReplayedCloseSnapshot('head-1', 3n, nodeWith(HydraHeadStatus.Closed, 5n))).resolves.toBe(false);

		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
	});

	it('lets the pass go on when the row moved under the write', async () => {
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 0 });

		await expect(recordReplayedCloseSnapshot('head-1', 3n, nodeWith(HydraHeadStatus.Final, 5n))).resolves.toBe(false);
	});
});
