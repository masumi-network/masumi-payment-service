/**
 * When an in-flight withdrawal row is treated as abandoned. Shared by the
 * withdrawal claim, which fails such a row, and the Host pause, which stops
 * waiting for it.
 */

import { HydraDecommitStatus } from '@/generated/prisma/client';

/**
 * After this, a Preparing row is treated as abandoned.
 *
 * Same reasoning as the top-up's equivalent: a Preparing row blocks the next
 * withdrawal and nothing else can resolve one, because it has no decommit id for
 * the head's events to match. Much shorter here — the split it is waiting on is
 * an in-head transaction, not an L1 confirmation.
 */
export const PREPARING_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * After this, a Pending row may be expired, if the node agrees.
 *
 * A withdrawal request whose transport answer was ambiguous stays Pending on
 * purpose — only the head can say whether it took it. But nothing else could
 * ever move that row: `Pending` and `Approved` are written only by the head's
 * own events, so a request the node provably never saw (a Host-proxy 502 while
 * the node restarts is enough) left the row Pending for good, and every later
 * withdrawal from that head was refused. The only way out was to close the head.
 *
 * Time alone is not enough to give up, though. A row expired while the head was
 * still deciding would report failure for funds that were on their way to L1. So
 * past this age the node is asked first, and the row is expired only when the
 * node answers that it holds no withdrawal at all. Even then the row is marked
 * with `PENDING_EXPIRED_REASON` rather than as an ordinary failure, so that a
 * late outcome from the head for the same transaction still settles it.
 *
 * `Approved` is deliberately NOT aged out. The head approved it, so the funds
 * are on their way to L1, and only the settlement can close that row.
 */
export const PENDING_STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * The failure reason of an expired Pending row.
 *
 * Also its marker: settlement matches on it to let a late authentic outcome
 * replace it, which a genuine refusal must never allow.
 */
export const PENDING_EXPIRED_REASON =
	'expired: the head held no withdrawal an hour after this request, so the outcome is unknown; ' +
	'a later answer from the head for this transaction still settles it';

/**
 * Every reason an expired Pending row has been written with. Rows expired
 * before the node was consulted carry the older text, and a late outcome must
 * be able to correct those too.
 */
export const PENDING_EXPIRED_REASONS = [PENDING_EXPIRED_REASON, 'the head never answered the withdrawal request'];

export type StaleWithdrawal =
	| { status: HydraDecommitStatus; reason: string }
	/** Old enough to expire, but only the node can say whether it is safe. */
	| 'ask-node';

/**
 * Whether the participant's active withdrawal may be failed so a new one can
 * start, `'ask-node'` when that depends on the node, or `null` when it still
 * blocks.
 */
export function staleWithdrawal(
	active: { status: HydraDecommitStatus; createdAt: Date; updatedAt: Date },
	nowMs: number,
	/** The node answered, and holds no withdrawal in flight. */
	nodeHoldsNoWithdrawal: boolean,
): StaleWithdrawal | null {
	if (active.status === HydraDecommitStatus.Preparing) {
		return nowMs - active.createdAt.getTime() > PREPARING_STALE_AFTER_MS
			? { status: HydraDecommitStatus.Preparing, reason: 'the in-head split never confirmed' }
			: null;
	}
	if (active.status === HydraDecommitStatus.Pending && nowMs - active.updatedAt.getTime() > PENDING_STALE_AFTER_MS) {
		return nodeHoldsNoWithdrawal ? { status: HydraDecommitStatus.Pending, reason: PENDING_EXPIRED_REASON } : 'ask-node';
	}
	return null;
}
