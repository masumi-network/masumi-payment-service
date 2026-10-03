/**
 * When a node earns back the attempts it spent coming up.
 *
 * `startAttempts` exists to stop a node that cannot run from being respawned
 * forever. It is spent before every spawn and refunded once the node is seen
 * working — so what counts as "working" decides whether the budget measures a
 * broken node or merely a long-lived one.
 *
 * It started at drift `Healthy` only. That left a node which had been serving
 * for hours still carrying the attempts from whatever brought it up, so its
 * next single crash met the exhausted budget and was recorded `Failed` with
 * "failed to stay up after 5 attempts" — about a node that had just been up all
 * afternoon. `Degraded` was added for that, and `Unsynced` was left out, which
 * is the same bug one verdict over and a worse one: a drift restart is itself a
 * spawn, and an `Unsynced` follower is the ordinary state of a
 * Blockfrost-backed node — its steady-state drift on this rig runs 120-250s
 * against a 150s unsynced period, at or above the guard. Four drift restarts
 * exhaust the budget across an hour in which the node was up the whole time,
 * and the next ordinary crash then reads as terminal.
 *
 * So: answering is the whole test. Drift needs no help from this budget — it
 * has its own stall window, its own progress re-anchor and its own restart
 * cooldown, and a node that cannot catch up is refused by `isUsable` anyway.
 */

/** Whether this observation refunds the node's spawn attempts. */
export function earnsStartBudgetRefund(observation: { responsive: boolean }): boolean {
	return observation.responsive;
}
