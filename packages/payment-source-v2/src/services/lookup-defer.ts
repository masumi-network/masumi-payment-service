// Shared sentinel for "defer-and-retry" signaling across V2 batch services.
//
// The batch services throw `new LookupDeferredError(...)` (preferred) or
// `new Error('${LOOKUP_DEFERRED_PREFIX} ...')` (legacy form, still
// supported) when they cannot make progress this tick but DO NOT want to
// park the request in `WaitingForManualAction` (which would require
// operator intervention to resume). The outer per-service catch arms call
// `isLookupDeferred(error)` to distinguish "defer to next tick" from "real
// failure → manual action".
//
// Prefer `LookupDeferredError` for new code: `instanceof` checks are
// resistant to message-text edits (a typo or stripped prefix can silently
// flip a defer into a manual-action park). The prefix form is preserved
// for backwards compatibility and for code paths that surface the message
// through a layer (e.g. advancedRetry) that loses the original error
// class.

export const LOOKUP_DEFERRED_PREFIX = 'V2_BATCH_LOOKUP_DEFERRED:';

export class LookupDeferredError extends Error {
	readonly isLookupDeferred = true as const;
	constructor(message: string) {
		super(`${LOOKUP_DEFERRED_PREFIX} ${message}`);
		this.name = 'LookupDeferredError';
	}
}

export function isLookupDeferred(error: unknown): boolean {
	if (error instanceof LookupDeferredError) return true;
	return error instanceof Error && error.message.startsWith(LOOKUP_DEFERRED_PREFIX);
}
