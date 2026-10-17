/**
 * When an in-flight withdrawal row is treated as abandoned. Shared by the
 * withdrawal claim, which fails such a row, and the Host pause, which stops
 * waiting for it.
 */

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
 * After this, a Pending row is treated as one the head never received.
 *
 * A withdrawal request whose transport answer was ambiguous stays Pending on
 * purpose — only the head can say whether it took it. But nothing else could
 * ever move that row: `Pending` and `Approved` are written only by the head's
 * own events, so a request the node provably never saw (a Host-proxy 502 while
 * the node restarts is enough) left the row Pending for good, and the withdrawal
 * claim refuses every later withdrawal from that head. The only way out was to
 * close the head.
 *
 * An hour is far past any decommit round. The head answers a request it took
 * within seconds, with DecommitApproved or DecommitInvalid, and a reconnect
 * replays the whole history so a missed frame is re-delivered. It is also safe
 * if that reasoning is somehow wrong: hydra-node refuses a second decommit
 * while one is in flight, so a fresh request cannot become a second withdrawal
 * of the same funds — it is refused by the node instead.
 *
 * `Approved` is deliberately NOT aged out. The head approved it, so the funds
 * are on their way to L1, and only the settlement can close that row.
 */
export const PENDING_STALE_AFTER_MS = 60 * 60 * 1000;
