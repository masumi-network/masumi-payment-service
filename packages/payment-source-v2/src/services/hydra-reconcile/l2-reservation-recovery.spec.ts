import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { Network, TransactionStatus } from '@/generated/prisma/client';
import {
	canReportExpiredL2Reservation,
	EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS,
	L2_RESERVATION_EXPIRY_GRACE_MS,
	L2_RESERVATION_RELEASE_GRACE_MS,
	reportExpiredL2Reservations,
} from './l2-reservation-recovery';

const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
const nowMs = 2_000_000;
const expiryMs = BigInt(nowMs - L2_RESERVATION_EXPIRY_GRACE_MS - 1);

function safeGate() {
	return {
		hasVerifiedPinnedSessions: true,
		historyReady: true,
		queuedTransactions: 0,
		headClock: { chainTimeMs: nowMs, receivedAtMs: nowMs },
		nowMs,
		validityUpperBoundTimeMs: expiryMs,
	};
}

describe('expired L2 reservation reporting gate', () => {
	it('reports only after the signed TTL plus grace', () => {
		expect(canReportExpiredL2Reservation(safeGate())).toBe(true);
		expect(
			canReportExpiredL2Reservation({
				...safeGate(),
				validityUpperBoundTimeMs: BigInt(nowMs - L2_RESERVATION_EXPIRY_GRACE_MS),
			}),
		).toBe(false);
	});

	it.each([
		['unpinned identity', { hasVerifiedPinnedSessions: false }],
		['partial history', { historyReady: false }],
		['queued causal evidence', { queuedTransactions: 1 }],
		['missing signed expiry', { validityUpperBoundTimeMs: null }],
		['stale live clock', { headClock: { chainTimeMs: nowMs, receivedAtMs: nowMs - 60_001 } }],
		['future live clock', { headClock: { chainTimeMs: nowMs + 5_001, receivedAtMs: nowMs } }],
	] as const)('fails closed for %s', (_label, override) => {
		expect(canReportExpiredL2Reservation({ ...safeGate(), ...override })).toBe(false);
	});
});

describe('expired L2 reservation reporting', () => {
	const recoveryNowMs = Date.UTC(2026, 6, 23, 12, 0, 0);
	const expirySlot = BigInt(
		unixTimeToEnclosingSlot(recoveryNowMs - L2_RESERVATION_EXPIRY_GRACE_MS - 5_000, SLOT_CONFIG_NETWORK.preprod),
	);

	beforeEach(() => {
		warnSpy.mockClear();
	});

	function harness(
		options: {
			candidateCount?: number;
			confirmed?: boolean;
			currentTxHash?: string | null;
			initialLock?: boolean;
			rejected?: boolean;
			inputRefs?: string[];
			unspentRefs?: string[];
			idPrefix?: string;
		} = {},
	) {
		const intendedTxHash = 'a'.repeat(64);
		// `number` is the verified snapshot the service sees; `nodeNumber` is what
		// the node itself reports on GET /snapshot (it can be ahead).
		const snapshot = { number: 7n, nodeNumber: 7n };
		const unspent = new Set(options.unspentRefs ?? options.inputRefs ?? []);
		const database = {
			hydraHead: { findUnique: jest.fn(async () => ({ latestSnapshotNumber: snapshot.number })) },
			transaction: {
				findMany: jest.fn(async () =>
					Array.from({ length: options.candidateCount ?? 1 }, (_, index) => ({
						id: `${options.idPrefix ?? 'reservation'}-${index + 1}`,
						intendedTxHash,
						txHash: options.currentTxHash ?? null,
						invalidHereafterSlot: expirySlot,
						l2ReservationPreviousTransactionId: options.initialLock ? null : 'previous-transaction',
						l2RejectedByHeadAt: options.rejected ? new Date(recoveryNowMs - 120_000) : null,
						l2ReservationInputRefs: options.inputRefs ?? [],
						l2ReservationPreviousLayer: null,
						l2ReservationPreviousSmartContractWalletId: null,
						l2ReservationPreviousBuyerReturnAddress: null,
						l2ReservationPreviousCollateralReturn: null,
					})),
				),
			},
			$transaction: jest.fn(),
		};
		const node = {
			hasVerifiedPinnedSessions: true,
			confirmedTransactionHistoryReady: true,
			headClock: { chainTimeMs: recoveryNowMs, receivedAtMs: recoveryNowMs },
			getConfirmedTransactionsForReconciliation: jest.fn(() => []),
			getConfirmedTransaction: jest.fn(() => (options.confirmed ? { txId: intendedTxHash } : null)),
			getVerifiedCurrentOutput: jest.fn((reference: string, number: bigint) =>
				number === snapshot.number && unspent.has(reference) ? 'output-bytes' : null,
			),
			expectedHeadId: 'f'.repeat(56),
			get: jest.fn(async (_url: string) => ({
				tag: 'ConfirmedSnapshot',
				snapshot: { headId: 'f'.repeat(56), number: Number(snapshot.nodeNumber) },
			})),
		};
		return { database, node, snapshot };
	}

	it.each([
		['intended-only', null],
		['TxValid', 'a'.repeat(64)],
	] as const)(
		'retains an expired %s reservation because replay absence is not negative proof',
		async (_label, txHash) => {
			const h = harness({ currentTxHash: txHash });
			await expect(
				reportExpiredL2Reservations({
					hydraHeadId: 'head-1',
					network: Network.Preprod,
					node: h.node as never,
					nowMs: recoveryNowMs,
					database: h.database as never,
				}),
			).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		},
	);

	it('also retains initial locks because replay absence cannot prove wallet inputs unspent', async () => {
		const h = harness({ initialLock: true });
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-1',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(1);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('retains an expired rejected initial lock because a node can withhold an earlier accepted snapshot', async () => {
		const h = harness({ initialLock: true, rejected: true });
		const mutationClient = {
			transaction: {
				findUnique: jest.fn(async () => ({
					status: TransactionStatus.Pending,
					txHash: null,
					l2RejectedByHeadAt: new Date(recoveryNowMs - 120_000),
					PurchaseRequestCurrent: [{ id: 'purchase-1', nextActionId: 'action-1' }],
				})),
				update: jest.fn(),
			},
			hotWallet: { updateMany: jest.fn() },
			purchaseRequest: { update: jest.fn() },
		};
		h.database.$transaction.mockImplementation(
			async (callback: unknown) =>
				await (callback as (client: typeof mutationClient) => Promise<unknown>)(mutationClient),
		);
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-rejected-initial-lock',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(1);
		expect(h.database.$transaction).not.toHaveBeenCalled();
		expect(mutationClient.transaction.update).not.toHaveBeenCalled();
		expect(mutationClient.hotWallet.updateMany).not.toHaveBeenCalled();
		expect(mutationClient.purchaseRequest.update).not.toHaveBeenCalled();
	});

	it('leaves confirmed evidence to the ordered replay path', async () => {
		const h = harness({ confirmed: true });
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-1',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(0);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('aggregates all expired reservations for one head into one bounded warning', async () => {
		const h = harness({ candidateCount: 3 });
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-warning-aggregate',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(3);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]).toEqual([
			expect.any(String),
			expect.objectContaining({
				expiredReservationCount: 3,
				transactionIdSamples: ['reservation-1', 'reservation-2', 'reservation-3'],
			}),
		]);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('throttles repeated warnings without mutating the reservation', async () => {
		const h = harness();
		const run = async (atMs: number) => {
			h.node.headClock = { chainTimeMs: atMs, receivedAtMs: atMs };
			return await reportExpiredL2Reservations({
				hydraHeadId: 'head-warning-throttle',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: atMs,
				database: h.database as never,
			});
		};

		await expect(run(recoveryNowMs)).resolves.toBe(1);
		await expect(run(recoveryNowMs)).resolves.toBe(1);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		await expect(run(recoveryNowMs + EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS)).resolves.toBe(1);
		expect(warnSpy).toHaveBeenCalledTimes(2);
		expect(h.database.$transaction).not.toHaveBeenCalled();
	});

	it('does not inspect reservations before authenticated history is ready', async () => {
		const h = harness();
		h.node.confirmedTransactionHistoryReady = false;
		await expect(
			reportExpiredL2Reservations({
				hydraHeadId: 'head-1',
				network: Network.Preprod,
				node: h.node as never,
				nowMs: recoveryNowMs,
				database: h.database as never,
			}),
		).resolves.toBe(0);
		expect(h.database.transaction.findMany).not.toHaveBeenCalled();
	});

	describe('proven-dead release', () => {
		const refs = [`${'b'.repeat(64)}#0`, `${'c'.repeat(64)}#1`];
		// Far enough past expiry for the release grace, not only the report grace.
		const releaseNowMs = recoveryNowMs + L2_RESERVATION_RELEASE_GRACE_MS;

		function withMutations(h: ReturnType<typeof harness>) {
			const mutationClient = {
				transaction: {
					findUnique: jest.fn(async () => ({
						status: TransactionStatus.Pending,
						txHash: null,
						l2RejectedByHeadAt: null,
						PurchaseRequestCurrent: [{ id: 'purchase-1', nextActionId: 'action-1' }],
					})),
					update: jest.fn(),
				},
				hotWallet: { updateMany: jest.fn() },
				purchaseRequest: { update: jest.fn() },
			};
			h.database.$transaction.mockImplementation(
				async (callback: unknown) =>
					await (callback as (client: typeof mutationClient) => Promise<unknown>)(mutationClient),
			);
			return mutationClient;
		}

		function scan(h: ReturnType<typeof harness>, hydraHeadId: string) {
			h.node.headClock = { chainTimeMs: releaseNowMs, receivedAtMs: releaseNowMs };
			return reportExpiredL2Reservations({
				hydraHeadId,
				network: Network.Preprod,
				node: h.node as never,
				nowMs: releaseNowMs,
				database: h.database as never,
			});
		}

		it('releases once a newer verified snapshot still holds every input', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'release' });
			const mutationClient = withMutations(h);

			// First sighting after expiry only records the baseline snapshot.
			await expect(scan(h, 'head-release')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();

			// Same snapshot again: a pre-expiry signature could still be in flight.
			await expect(scan(h, 'head-release')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();

			h.snapshot.number = 8n;
			await expect(scan(h, 'head-release')).resolves.toBe(0);
			expect(mutationClient.hotWallet.updateMany).toHaveBeenCalledWith({
				where: { pendingTransactionId: 'release-1' },
				data: { lockedAt: null, pendingTransactionId: null },
			});
			expect(mutationClient.transaction.update).toHaveBeenCalledWith(
				expect.objectContaining({ data: expect.objectContaining({ status: TransactionStatus.RolledBack }) }),
			);
		});

		it('never releases when any input is spent, because the body may have applied', async () => {
			const h = harness({ inputRefs: refs, unspentRefs: [refs[0]], idPrefix: 'spent' });
			withMutations(h);
			await expect(scan(h, 'head-spent')).resolves.toBe(1);
			h.snapshot.number = 8n;
			await expect(scan(h, 'head-spent')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('retains reservations recorded before inputs were stored', async () => {
			const h = harness({ inputRefs: [], idPrefix: 'legacy' });
			withMutations(h);
			await expect(scan(h, 'head-legacy')).resolves.toBe(1);
			h.snapshot.number = 8n;
			await expect(scan(h, 'head-legacy')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('does not release inside the release grace even with a newer snapshot', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'grace' });
			withMutations(h);
			const run = () =>
				reportExpiredL2Reservations({
					hydraHeadId: 'head-grace',
					network: Network.Preprod,
					node: h.node as never,
					nowMs: recoveryNowMs,
					database: h.database as never,
				});
			await expect(run()).resolves.toBe(1);
			h.snapshot.number = 8n;
			await expect(run()).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		// The service's verified snapshot can lag the node. The baseline must be
		// the node's own number, or a snapshot the node signed before expiry
		// (and the peer withheld) could be skipped over.
		it('baselines on the node snapshot, not the lagging verified one', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'lag' });
			withMutations(h);
			h.snapshot.nodeNumber = 8n;
			await expect(scan(h, 'head-lag')).resolves.toBe(1);
			expect(h.node.get).toHaveBeenCalledWith('/snapshot');

			h.snapshot.number = 8n;
			await expect(scan(h, 'head-lag')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();

			h.snapshot.number = 9n;
			await expect(scan(h, 'head-lag')).resolves.toBe(0);
			expect(h.database.$transaction).toHaveBeenCalledTimes(1);
		});

		it('baselines on the verified snapshot when the node reports a lower number', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'node-behind' });
			withMutations(h);
			h.snapshot.nodeNumber = 5n;
			await expect(scan(h, 'head-node-behind')).resolves.toBe(1);
			// Baseline is max(5, 7) = 7, so snapshot 7 must not release.
			await expect(scan(h, 'head-node-behind')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
			h.snapshot.number = 8n;
			await expect(scan(h, 'head-node-behind')).resolves.toBe(0);
		});

		// A baseline older than a day is dropped and re-read from the node, which
		// can only raise it. Without the prune, snapshot 8 would release here.
		it('re-baselines after the age limit instead of releasing on a stale baseline', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'aged' });
			withMutations(h);
			const scanAt = (atMs: number) => {
				h.node.headClock = { chainTimeMs: atMs, receivedAtMs: atMs };
				return reportExpiredL2Reservations({
					hydraHeadId: 'head-aged',
					network: Network.Preprod,
					node: h.node as never,
					nowMs: atMs,
					database: h.database as never,
				});
			};
			await expect(scanAt(releaseNowMs)).resolves.toBe(1);
			h.snapshot.number = 8n;
			h.snapshot.nodeNumber = 9n;
			await expect(scanAt(releaseNowMs + 25 * 60 * 60_000)).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});

		it('records no baseline when the node reports a different head', async () => {
			const h = harness({ inputRefs: refs, idPrefix: 'other-head' });
			withMutations(h);
			h.node.expectedHeadId = 'e'.repeat(56);
			await expect(scan(h, 'head-other')).resolves.toBe(1);
			h.snapshot.number = 8n;
			h.snapshot.nodeNumber = 8n;
			await expect(scan(h, 'head-other')).resolves.toBe(1);
			expect(h.database.$transaction).not.toHaveBeenCalled();
		});
	});
});
