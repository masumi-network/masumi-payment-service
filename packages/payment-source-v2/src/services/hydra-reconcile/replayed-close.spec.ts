import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import type { ClosedHeadFacts } from '@/lib/hydra/hydra/head-output-tx';

const mockHydraHeadUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockFetchClosedHeadFacts = jest.fn<() => Promise<ClosedHeadFacts | undefined>>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hydraHead: { updateMany: mockHydraHeadUpdateMany } },
}));

const mockWarn = jest.fn();

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: mockWarn, error: jest.fn(), debug: jest.fn() },
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

	it('restores a lower replayed Closed snapshot after an offline contest rollback', async () => {
		await expect(recordReplayedCloseSnapshot('head-1', 5n, nodeWith(HydraHeadStatus.Closed, 3n))).resolves.toBe(true);

		expect(mockFetchClosedHeadFacts).toHaveBeenCalledTimes(1);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: 'head-1',
					status: HydraHeadStatus.Closed,
					latestSnapshotNumber: 5n,
				}),
				data: { latestSnapshotNumber: 3n, contestationDeadline: new Date(CONTEST_DEADLINE) },
			}),
		);
	});

	it('holds an offline rollback until the node returns a valid deadline', async () => {
		mockFetchClosedHeadFacts.mockResolvedValue(undefined);
		await expect(recordReplayedCloseSnapshot('head-1', 5n, nodeWith(HydraHeadStatus.Closed, 3n))).resolves.toBe(false);
		mockFetchClosedHeadFacts.mockResolvedValue({ contestationDeadline: 'invalid' });
		await expect(recordReplayedCloseSnapshot('head-1', 5n, nodeWith(HydraHeadStatus.Closed, 3n))).resolves.toBe(false);
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
	});

	it('does not restore a replay that fell behind the live head during the deadline read', async () => {
		let currentClosedSnapshot = 3n;
		const node = {
			status: HydraHeadStatus.Closed,
			get closedSnapshotNumber() {
				return currentClosedSnapshot;
			},
			fetchClosedHeadFacts: mockFetchClosedHeadFacts,
		};
		mockFetchClosedHeadFacts.mockImplementation(async () => {
			currentClosedSnapshot = 5n;
			return { contestationDeadline: CONTEST_DEADLINE };
		});

		await expect(recordReplayedCloseSnapshot('head-1', 5n, node)).resolves.toBe(false);
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
	});

	it.each([HydraHeadStatus.FanoutPossible, HydraHeadStatus.FanningOut, HydraHeadStatus.Final])(
		'restores a lower replayed snapshot for a %s head before handoff',
		async (status) => {
			await expect(recordReplayedCloseSnapshot('head-1', 5n, nodeWith(status, 3n))).resolves.toBe(true);
			expect(mockFetchClosedHeadFacts).not.toHaveBeenCalled();
			expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
				expect.objectContaining({
					where: expect.objectContaining({ status, latestSnapshotNumber: 5n, reconciliationCompletedAt: null }),
					data: { latestSnapshotNumber: 3n },
				}),
			);
		},
	);

	it('warns once when a closed head has no close in its replayed history', async () => {
		// The row then keeps its number and the handoff waits, so the warning is the only clue.
		const node = nodeWith(HydraHeadStatus.FanoutPossible, undefined);

		await expect(recordReplayedCloseSnapshot('head-no-close', 0n, node)).resolves.toBe(false);
		await expect(recordReplayedCloseSnapshot('head-no-close', 0n, node)).resolves.toBe(false);

		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(mockWarn).toHaveBeenCalledTimes(1);
	});

	it('warns again after a close was seen and then lost', async () => {
		await recordReplayedCloseSnapshot('head-lost-close', 0n, nodeWith(HydraHeadStatus.Closed, undefined));
		await recordReplayedCloseSnapshot('head-lost-close', 5n, nodeWith(HydraHeadStatus.Closed, 5n));
		await recordReplayedCloseSnapshot('head-lost-close', 5n, nodeWith(HydraHeadStatus.Closed, undefined));

		expect(mockWarn).toHaveBeenCalledTimes(2);
	});

	it('does not warn for an open head, which has no close to replay', async () => {
		await expect(recordReplayedCloseSnapshot('head-open', 0n, nodeWith(HydraHeadStatus.Open, undefined))).resolves.toBe(
			false,
		);

		expect(mockWarn).not.toHaveBeenCalled();
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
