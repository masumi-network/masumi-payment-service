import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import { Network } from '@/generated/prisma/client';
import {
	canReportExpiredL2Reservation,
	EXPIRED_L2_RESERVATION_WARNING_INTERVAL_MS,
	L2_RESERVATION_EXPIRY_GRACE_MS,
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
		} = {},
	) {
		const intendedTxHash = 'a'.repeat(64);
		const database = {
			transaction: {
				findMany: jest.fn(async () =>
					Array.from({ length: options.candidateCount ?? 1 }, (_, index) => ({
						id: `reservation-${index + 1}`,
						intendedTxHash,
						txHash: options.currentTxHash ?? null,
						invalidHereafterSlot: expirySlot,
						l2ReservationPreviousTransactionId: options.initialLock ? null : 'previous-transaction',
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
		};
		return { database, node };
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
});
