/**
 * The stall reason the reconciler records when a confirmed body cannot be
 * applied yet. A leaf, so the admin re-apply can read it without loading the
 * reconciler.
 */
export const REPLAY_APPLY_RETRY_REASON = 'replay-apply-retry';
