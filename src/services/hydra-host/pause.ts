/**
 * Pausing a Hydra Host for maintenance, such as a redeploy to a new release.
 *
 * A pause moves through four phases, and every one of them is derived from the
 * database and the Host, never from memory. A service restart, a second
 * service instance, or a closed browser therefore cannot lose a pause halfway:
 *
 *   Active   -> no pause.
 *   Draining -> `pausedAt` is set. The service starts no new work on the Host's
 *               heads, and waits for its own in-flight work (held L2 bodies,
 *               top-ups, withdrawals) to finish, and for closing heads to
 *               settle, because a stopped node cannot contest or fan out.
 *   Stopping -> the Host was asked to stop the nodes. It drains each node's
 *               snapshot round first.
 *   Paused   -> every paused node reports Stopped. No transaction can happen on
 *               these heads, from either side, until Resume.
 *
 * The scheduler calls `advanceHydraHostPause` for every Draining Host, so the
 * nodes stop as soon as the in-flight work is done, whoever is watching.
 *
 * While the nodes are stopped this side cannot contest a close, so a pause must
 * stay short. The admin UI says so next to the timer.
 */

import createHttpError from 'http-errors';
import {
	HydraDecommitStatus,
	HydraHeadStatus,
	HydraTopupStatus,
	Prisma,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { decrypt } from '@/utils/security/encryption';
import { fetchHostNodeHealth, HydraHostRequestError, startHostNode, stopHostNode } from './client';

export const HYDRA_HOST_PAUSED_MESSAGE = 'hydra host is paused for maintenance';

export type HydraHostPausePhase = 'Active' | 'Draining' | 'Stopping' | 'Paused';

export type HydraHostPauseInFlight = {
	l2Transactions: number;
	topups: number;
	withdrawals: number;
	/** Heads closing or in their dispute window. A stopped node cannot contest or fan out. */
	closingHeads: number;
};

export type HydraHostPauseState = {
	hostId: string;
	phase: HydraHostPausePhase;
	pausedAt: string | null;
	pauseStopRequestedAt: string | null;
	inFlight: HydraHostPauseInFlight;
	nodes: Array<{ nodeId: string; state: string | null; error: string | null }>;
};

/** Top-ups the node still has to act on: building, posted, or confirmed but not yet absorbed. */
const IN_FLIGHT_TOPUP_STATUSES = [HydraTopupStatus.Preparing, HydraTopupStatus.Pending, HydraTopupStatus.Confirmed];
/** Withdrawals the node still has to act on: an approved decommit is posted to L1 by the node. */
const IN_FLIGHT_WITHDRAWAL_STATUSES = [
	HydraDecommitStatus.Preparing,
	HydraDecommitStatus.Pending,
	HydraDecommitStatus.Approved,
];

const HTTP_NOT_FOUND = 404;
/** Bounds a held pause lock: one Host request per node, each with its own timeout. */
const PAUSE_LOCK_TIMEOUT_MS = 5 * 60_000;

type PrismaReader = Pick<Prisma.TransactionClient, 'hydraLocalParticipant'>;

/** Whether the head's node lives on a paused Host. False for a head with no local node. */
export async function isHydraHeadOnPausedHost(hydraHeadId: string, client: PrismaReader = prisma): Promise<boolean> {
	const participant = await client.hydraLocalParticipant.findUnique({
		where: { hydraHeadId },
		select: { HydraHost: { select: { pausedAt: true } } },
	});
	return participant?.HydraHost.pausedAt != null;
}

/**
 * The same question, asked inside an L2 reservation transaction.
 *
 * `FOR SHARE` on the Host row orders the reservation against a pause, which
 * takes `FOR UPDATE` on that row: a reservation that read "not paused" commits
 * its row before the pause can, so the pause's in-flight count sees it and
 * waits for it. Without the lock, a reservation could slip in after the count
 * and find its node stopped.
 */
export async function isHydraHeadOnPausedHostLocked(
	tx: Prisma.TransactionClient,
	hydraHeadId: string,
): Promise<boolean> {
	const rows = await tx.$queryRaw<Array<{ pausedAt: Date | null }>>(
		Prisma.sql`
			SELECT h."pausedAt"
			FROM "HydraHost" h
			JOIN "HydraLocalParticipant" p ON p."hydraHostId" = h."id"
			WHERE p."hydraHeadId" = ${hydraHeadId}
			FOR SHARE OF h
		`,
	);
	return rows[0]?.pausedAt != null;
}

/** For routes: refuse to start new work on a head whose Host is paused. */
export async function assertHydraHeadHostNotPaused(hydraHeadId: string): Promise<void> {
	if (await isHydraHeadOnPausedHost(hydraHeadId)) {
		throw createHttpError(409, `${HYDRA_HOST_PAUSED_MESSAGE}; resume it before starting new work on this head`);
	}
}

async function countInFlight(hostId: string): Promise<HydraHostPauseInFlight> {
	const onHost = { LocalParticipant: { hydraHostId: hostId } };
	const [l2Transactions, topups, withdrawals, closingHeads] = await Promise.all([
		prisma.transaction.count({
			where: { layer: TransactionLayer.L2, status: TransactionStatus.Pending, HydraHead: onHost },
		}),
		prisma.hydraTopup.count({ where: { status: { in: IN_FLIGHT_TOPUP_STATUSES }, HydraHead: onHost } }),
		prisma.hydraDecommit.count({ where: { status: { in: IN_FLIGHT_WITHDRAWAL_STATUSES }, HydraHead: onHost } }),
		prisma.hydraHead.count({
			where: {
				LocalParticipant: { hydraHostId: hostId },
				OR: [{ isClosing: true }, { status: { in: [HydraHeadStatus.Closed, HydraHeadStatus.FanoutPossible] } }],
			},
		}),
	]);
	return { l2Transactions, topups, withdrawals, closingHeads };
}

function hasInFlightWork(inFlight: HydraHostPauseInFlight): boolean {
	return inFlight.l2Transactions + inFlight.topups + inFlight.withdrawals + inFlight.closingHeads > 0;
}

/** The Host no longer has this node, for example one removed by hand after its head went Final. */
function isNodeGone(error: unknown): boolean {
	return error instanceof HydraHostRequestError && error.status === HTTP_NOT_FOUND;
}

/**
 * Advance and Resume each act on the Host over the network and then write.
 * Run them one at a time per Host, across every service instance: interleaved,
 * an advance's stops could land after a Resume's starts, and the Host would
 * read as running with every node stopped.
 */
async function withHostPauseLock<T>(hostId: string, action: () => Promise<T>): Promise<T> {
	return await prisma.$transaction(
		async (tx) => {
			// Returns an integer, not PostgreSQL's `void`; see settle-lock.ts.
			await tx.$queryRaw<Array<{ acquired: number }>>`
				WITH pause_lock AS MATERIALIZED (
					SELECT pg_advisory_xact_lock(hashtextextended(${`hydra-host-pause:${hostId}`}, 0))
				)
				SELECT 1 AS acquired FROM pause_lock
			`;
			return await action();
		},
		{ maxWait: PAUSE_LOCK_TIMEOUT_MS, timeout: PAUSE_LOCK_TIMEOUT_MS },
	);
}

async function loadHost(hostId: string) {
	const host = await prisma.hydraHost.findUnique({ where: { id: hostId } });
	if (!host) {
		throw createHttpError(404, 'hydra host not found');
	}
	return host;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function getHydraHostPauseState(hostId: string): Promise<HydraHostPauseState> {
	const host = await loadHost(hostId);
	const inFlight = await countInFlight(hostId);
	const base = {
		hostId,
		pausedAt: host.pausedAt?.toISOString() ?? null,
		pauseStopRequestedAt: host.pauseStopRequestedAt?.toISOString() ?? null,
		inFlight,
	};
	if (host.pausedAt === null) {
		return { ...base, phase: 'Active', nodes: [] };
	}
	if (host.pauseStopRequestedAt === null) {
		return {
			...base,
			phase: hasInFlightWork(inFlight) ? 'Draining' : 'Stopping',
			nodes: host.pausedNodeIds.map((nodeId) => ({ nodeId, state: null, error: null })),
		};
	}

	// The Host is the only witness of whether a node has actually stopped: the
	// stop request returns at once, and the drain before it can take minutes.
	const userToken = decrypt(host.encryptedUserToken);
	const nodes = await Promise.all(
		host.pausedNodeIds.map(async (nodeId) => {
			try {
				const health = await fetchHostNodeHealth(host.baseUrl, userToken, nodeId, {
					allowInsecureHttp: host.allowInsecureHttp,
				});
				return { nodeId, state: health.state, error: null };
			} catch (error) {
				// A node the Host no longer has cannot be running.
				if (isNodeGone(error)) return { nodeId, state: 'Stopped', error: 'not found on the host' };
				return { nodeId, state: null, error: errorMessage(error) };
			}
		}),
	);
	const allStopped = nodes.every((node) => node.state === 'Stopped');
	return { ...base, phase: allStopped ? 'Paused' : 'Stopping', nodes };
}

/**
 * Start a pause. Idempotent: pausing a paused Host only advances it.
 *
 * The nodes to stop are fixed in the same locked write that sets `pausedAt`,
 * so two service instances advancing the same pause agree on the set, and
 * Resume starts exactly the nodes the pause stopped.
 */
export async function pauseHydraHost(hostId: string, options: { force: boolean }): Promise<HydraHostPauseState> {
	await prisma.$transaction(async (tx) => {
		const rows = await tx.$queryRaw<Array<{ pausedAt: Date | null; encryptedAdminToken: string | null }>>(
			Prisma.sql`SELECT "pausedAt", "encryptedAdminToken" FROM "HydraHost" WHERE "id" = ${hostId} FOR UPDATE`,
		);
		const row = rows[0];
		if (!row) {
			throw createHttpError(404, 'hydra host not found');
		}
		if (row.encryptedAdminToken === null) {
			// Stopping a node is an admin-tier Host call. Without it the pause could
			// block new work but never reach Paused, which reads as safe and is not.
			throw createHttpError(409, 'this hydra host is registered without an admin token, so it cannot be paused');
		}
		if (row.pausedAt !== null) return;

		const participants = await tx.hydraLocalParticipant.findMany({
			where: { hydraHostId: hostId, hydraHeadId: { not: null } },
			select: { hostNodeId: true },
		});
		await tx.hydraHost.update({
			where: { id: hostId },
			data: {
				pausedAt: new Date(),
				pausedNodeIds: participants.map((participant) => participant.hostNodeId),
				pauseStopRequestedAt: null,
			},
		});
	});
	return await advanceHydraHostPause(hostId, options);
}

/**
 * Stop the paused nodes once no in-flight work needs them, or at once when
 * forced. Safe to call any number of times, from any instance.
 */
export async function advanceHydraHostPause(hostId: string, options: { force: boolean }): Promise<HydraHostPauseState> {
	await withHostPauseLock(hostId, async () => {
		const host = await loadHost(hostId);
		if (host.pausedAt === null || host.pauseStopRequestedAt !== null || host.encryptedAdminToken === null) return;
		if (!options.force && hasInFlightWork(await countInFlight(hostId))) return;

		const adminToken = decrypt(host.encryptedAdminToken);
		const failures: string[] = [];
		for (const nodeId of host.pausedNodeIds) {
			try {
				await stopHostNode(host.baseUrl, adminToken, nodeId, { allowInsecureHttp: host.allowInsecureHttp });
			} catch (error) {
				if (!isNodeGone(error)) failures.push(`${nodeId}: ${errorMessage(error)}`);
			}
		}
		if (failures.length > 0) {
			// Left Stopping-without-a-request: the next scheduler cycle asks again.
			// Stop is idempotent on the Host, so the nodes that did stop are fine.
			logger.warn('[HydraHostPause] could not stop every paused node; retrying next cycle', { hostId, failures });
			return;
		}
		await prisma.hydraHost.updateMany({
			where: { id: hostId, pausedAt: host.pausedAt, pauseStopRequestedAt: null },
			data: { pauseStopRequestedAt: new Date() },
		});
	});
	return await getHydraHostPauseState(hostId);
}

/**
 * End a pause: start exactly the nodes it stopped, then clear it.
 *
 * The pause stays set until every start succeeded, so a half-resumed Host
 * keeps refusing new work instead of sending it to a node that is still down.
 */
export async function resumeHydraHost(hostId: string): Promise<HydraHostPauseState> {
	await withHostPauseLock(hostId, async () => {
		const host = await loadHost(hostId);
		if (host.pausedAt === null) return;
		if (host.encryptedAdminToken === null) {
			throw createHttpError(409, 'this hydra host is registered without an admin token, so it cannot be resumed');
		}

		const adminToken = decrypt(host.encryptedAdminToken);
		const failures: string[] = [];
		for (const nodeId of host.pausedNodeIds) {
			try {
				await startHostNode(host.baseUrl, adminToken, nodeId, { allowInsecureHttp: host.allowInsecureHttp });
			} catch (error) {
				// Skipped, not failed: a node the Host no longer has would otherwise
				// keep the Host paused forever.
				if (isNodeGone(error)) {
					logger.warn('[HydraHostPause] paused node no longer exists on the host; skipped', { hostId, nodeId });
					continue;
				}
				failures.push(`${nodeId}: ${errorMessage(error)}`);
			}
		}
		if (failures.length > 0) {
			throw createHttpError(502, `could not start every paused node; the host stays paused: ${failures.join('; ')}`);
		}
		await prisma.hydraHost.updateMany({
			where: { id: hostId, pausedAt: host.pausedAt },
			data: { pausedAt: null, pausedNodeIds: [], pauseStopRequestedAt: null },
		});
	});
	return await getHydraHostPauseState(hostId);
}

/** Scheduler entry: move every Draining or Stopping pause forward. */
export async function runHydraHostPauseCycle(): Promise<void> {
	const hosts = await prisma.hydraHost.findMany({
		where: { pausedAt: { not: null }, pauseStopRequestedAt: null },
		select: { id: true },
	});
	for (const host of hosts) {
		try {
			await advanceHydraHostPause(host.id, { force: false });
		} catch (error) {
			logger.warn('[HydraHostPause] could not advance pause', { hostId: host.id, error });
		}
	}
}
