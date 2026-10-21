/**
 * Retiring a head that cannot reach Final.
 *
 * A head holding an output no fanout transaction can move never burns its
 * tokens, so it never becomes Final, and a relation allows only one live head.
 * Retiring the head frees the relation. It does not move any funds: what is
 * left in the head stays on L1 behind the head script. The record keeps what a
 * later recovery needs (the head identifier, the L1 tx that holds the head
 * output, the remaining UTxO set and the operator's reason). See ADR 0013.
 */

import { HydraHeadStatus, Prisma } from '@/generated/prisma/client';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';

import type { HydraFanoutHeadState } from '@/lib/hydra/hydra/fanout-head-state';
import { HydraHeadInitObservationError } from '@/lib/hydra/hydra/head-init-validation';
import { forgetHeadFailedClosed } from '@/services/hydra-connection-manager/head-auto-disable-recovery';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { HYDRA_HEAD_STATUS_RANK } from '@/services/hydra-connection-manager/head-status-rank';

import { readHeadChainState } from './chain-check';
import { lifecycleInput, lifecycleOutput } from './lifecycle';
import { assertNodeAwaitsFanoutSelection, readFanoutHeadState } from './partial-fanout';

/** Statuses past close where fanout can stall. Open and earlier heads close instead. */
export const RETIRABLE_HEAD_STATUSES: ReadonlySet<HydraHeadStatus> = new Set([
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.FanningOut,
]);

const MAX_RETIRE_REASON_LENGTH = 1000;

export const retireHeadInput = lifecycleInput.extend({
	reason: z
		.string()
		.trim()
		.min(10)
		.max(MAX_RETIRE_REASON_LENGTH)
		.describe('Why the head cannot reach Final. Stored with the head for a later recovery.'),
	/**
	 * Named for what the operator accepts: whatever is left in the head stays on
	 * L1 behind the head script, and this service stops tracking it.
	 */
	acknowledgeStrandedFunds: z.literal(true),
	/** Retire even though the node cannot report the remaining UTxO set. */
	acknowledgeRemainingUtxoUnknown: z.boolean().optional(),
	/**
	 * Retire although the node is still in a fanout mode that posts steps on its
	 * own. For a step that can never post, which leaves the node in that mode.
	 */
	acknowledgeFanoutStalled: z.boolean().optional(),
});

export const retireHeadOutput = lifecycleOutput.extend({
	retiredAt: z.string(),
	retiredHeadOutputTxHash: z.string(),
	remainingUtxoCount: z.number().nullable(),
});

async function readHeadOutputOnChain(headId: string): Promise<string> {
	let chain: Awaited<ReturnType<typeof readHeadChainState>>;
	try {
		chain = await readHeadChainState(headId);
	} catch (error) {
		if (createHttpError.isHttpError(error)) throw error;
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof HydraHeadInitObservationError) throw createHttpError(503, message);
		throw createHttpError(502, `Could not read the head state on chain: ${message}`);
	}
	if (chain.state === 'gone') {
		throw createHttpError(409, 'The head was fanned out on L1; reconciliation adopts it, nothing to retire');
	}
	if (chain.state === 'open') throw createHttpError(409, 'L1 shows the head Open; close it instead of retiring it');
	return chain.latestTxHash;
}

/**
 * The node sees a fanout before this service persists it. A node already past
 * the stored status is settling the head, and retiring it would hide that.
 */
function assertNodeNotPastStatus(headId: string, status: HydraHeadStatus): void {
	const nodeStatus = getHydraConnectionManager().getNode(headId)?.status;
	if (nodeStatus != null && HYDRA_HEAD_STATUS_RANK[nodeStatus] > HYDRA_HEAD_STATUS_RANK[status]) {
		throw createHttpError(409, `The Hydra node reports the head ${nodeStatus}; it is settling, nothing to retire`);
	}
}

/**
 * The node's report of what the head still holds, keyed by in-head reference.
 * A node still fanning out on its own is refused unless the stall is
 * acknowledged. Acknowledging an unknown set does not cover it: the set is
 * known, and the head may be settling.
 */
async function readRemainingUtxo(
	headId: string,
	acknowledge: { remainingUnknown: boolean; fanoutStalled: boolean },
): Promise<Prisma.InputJsonObject | null> {
	const node = getHydraConnectionManager().getNode(headId);
	let state: HydraFanoutHeadState;
	try {
		if (!node) throw new Error('no active connection to the Hydra node');
		state = await readFanoutHeadState(node);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (acknowledge.remainingUnknown) {
			logger.warn(`[HydraAPI] Retiring head ${headId} without its remaining UTxO set: ${message}`);
			return null;
		}
		// The node answered, but with a state that cannot be retired from (not
		// closed, or unreadable): keep that status rather than calling it down.
		if (createHttpError.isHttpError(error)) {
			throw createHttpError(error.status, `${message}; pass acknowledgeRemainingUtxoUnknown to retire without it`);
		}
		throw createHttpError(
			503,
			`Could not read the remaining UTxO set from the node (${message}); ` +
				'retry, or pass acknowledgeRemainingUtxoUnknown to retire without it',
		);
	}
	assertNodeAwaitsFanoutSelection(state, { allowed: acknowledge.fanoutStalled, flag: 'acknowledgeFanoutStalled' });
	// Prisma JSON cannot hold BigInt quantities; strings keep them exact.
	return JSON.parse(
		JSON.stringify(state.selectable, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value)),
	) as Prisma.InputJsonObject;
}

export const retireHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: retireHeadInput,
	output: retireHeadOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			select: { id: true, status: true, retiredAt: true, contestationDeadline: true },
		});
		if (!head) throw createHttpError(404, 'Hydra head not found');
		if (head.retiredAt) throw createHttpError(409, 'Hydra head is already retired');
		if (!RETIRABLE_HEAD_STATUSES.has(head.status)) {
			throw createHttpError(
				409,
				`Cannot retire: head status is ${head.status}, expected one of ${[...RETIRABLE_HEAD_STATUSES].join(', ')}`,
			);
		}
		// Inside the contestation period the head may still need contesting, and
		// retiring it stops this service from watching it.
		if (
			head.status === HydraHeadStatus.Closed &&
			(head.contestationDeadline == null || head.contestationDeadline.getTime() > Date.now())
		) {
			throw createHttpError(409, 'Cannot retire a Closed head before its contestation deadline has passed');
		}

		// Independent of the node: a head that L1 shows fanned out or still open
		// is not stuck, and retiring it would strand a settleable head.
		assertNodeNotPastStatus(head.id, head.status);
		const retiredHeadOutputTxHash = await readHeadOutputOnChain(head.id);
		const remainingUtxo = await readRemainingUtxo(head.id, {
			remainingUnknown: input.acknowledgeRemainingUtxoUnknown === true,
			fanoutStalled: input.acknowledgeFanoutStalled === true,
		});
		const remainingUtxoCount = remainingUtxo ? Object.keys(remainingUtxo).length : null;
		// The node read above can take a while. Read L1 again just before the
		// write: a fanout that landed meanwhile moves the head output. A fanout
		// posted but not yet on chain stays invisible here (see ADR 0013).
		assertNodeNotPastStatus(head.id, head.status);
		if ((await readHeadOutputOnChain(head.id)) !== retiredHeadOutputTxHash) {
			throw createHttpError(409, 'The head output moved on L1 while the head was being retired');
		}

		const retiredAt = new Date();
		// Guarded on the status read above, so a head that moved on meanwhile
		// (for example a fanout that landed) is not retired. The init anchors the
		// head still has stay: a later recovery restarts the node from them. The
		// epoch bump fences the old session, so it cannot write to the record.
		const retired = await prisma.hydraHead.updateMany({
			where: { id: head.id, status: head.status, retiredAt: null },
			data: {
				isEnabled: false,
				ownerEpoch: { increment: 1 },
				retiredAt,
				retiredReason: input.reason,
				retiredRemainingUtxo: remainingUtxo ?? Prisma.DbNull,
				retiredHeadOutputTxHash,
			},
		});
		if (retired.count !== 1) throw createHttpError(409, 'Hydra head changed while it was being retired');
		// The operator's decision now: automatic recovery must not re-enable it.
		// Only after the write: a refused retire keeps the head's auto-recovery.
		forgetHeadFailedClosed(head.id);
		await getHydraConnectionManager().reconcileEnabledState(head.id);

		logger.warn(`[HydraAPI] Head ${head.id} retired without reaching Final`, {
			status: head.status,
			retiredHeadOutputTxHash,
			remainingUtxoCount,
		});
		return {
			headId: head.id,
			status: head.status,
			retiredAt: retiredAt.toISOString(),
			retiredHeadOutputTxHash,
			remainingUtxoCount,
		};
	},
});
