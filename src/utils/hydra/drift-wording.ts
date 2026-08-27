/**
 * Turning a chain-follower gap into words an operator can act on.
 *
 * Shared by the node-state reason and the Init-observation note so the two
 * cannot drift apart in wording — they describe the same condition, and an
 * operator who reads both should not have to work out that they agree.
 *
 * The important case is the one that reads as a bug. Drift is derived from the
 * `currentSlot` a node reports, converted through the network's Shelley genesis
 * constants; a node whose chain follower has not yet reached a chain point
 * reports slot 0, which converts to the moment before the network existed. On
 * preprod that renders as "1521.4 days behind" — a number no operator can act
 * on, from a node that had merely just started. So a gap that could only come
 * from a follower with no chain point is reported as exactly that.
 */

/**
 * Beyond this, the gap is not a measurement.
 *
 * Deliberately far above any real outage rather than just above a healthy node.
 * A node stopped for a week and restarted genuinely IS a week behind — its
 * follower resumes from the chain point it persisted — and calling that "no
 * chain point" would hide the one fact the operator needs. What cannot happen
 * is a gap approaching the age of the network itself: a follower's persisted
 * point is never older than its first sync. Slot 0 converts to before genesis,
 * so it always exceeds this, and it is the only thing that does.
 *
 * A year is comfortably above the longest outage worth describing and
 * comfortably below the age of either network we run on (preprod opened
 * 2022-06-21, mainnet Shelley 2020-07-29), and the margin only grows.
 */
export const NO_CHAIN_POINT_THRESHOLD_SECONDS = 365 * 24 * 60 * 60;

/** Whether this gap means "has no chain point" rather than "is behind by". */
export function hasNoChainPoint(driftSeconds: number | null): boolean {
	return driftSeconds !== null && Number.isFinite(driftSeconds) && driftSeconds >= NO_CHAIN_POINT_THRESHOLD_SECONDS;
}

/**
 * How far behind, rounded to the unit that answers "wait, or intervene?".
 *
 * Returns null when the gap is not a measurement, so callers phrase that case
 * themselves rather than appending a number to a sentence it contradicts.
 */
export function formatDriftBehind(driftSeconds: number): string | null {
	if (!Number.isFinite(driftSeconds) || driftSeconds <= 0) return null;
	if (hasNoChainPoint(driftSeconds)) return null;
	if (driftSeconds < 90) return `${Math.round(driftSeconds)} seconds`;
	const minutes = driftSeconds / 60;
	if (minutes < 90) return `${Math.round(minutes)} minutes`;
	const hours = minutes / 60;
	if (hours < 48) return `${hours.toFixed(1)} hours`;
	return `${(hours / 24).toFixed(1)} days`;
}
