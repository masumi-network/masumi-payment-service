// Shared sentinel for "defer-and-retry" signaling across V2 batch services.
//
// The batch services throw `new Error('${LOOKUP_DEFERRED_PREFIX} ...')` when
// they cannot make progress this tick but DO NOT want to park the request in
// `WaitingForManualAction` (which would require operator intervention to
// resume). The outer per-service catch arms call `isLookupDeferred(error)` to
// distinguish "defer to next tick" from "real failure → manual action".
//
// Keep this string stable: changing it breaks every existing batch-fallback
// catch arm at once. If the wire format needs to change, do it in one commit
// that updates every dependent service.

export const LOOKUP_DEFERRED_PREFIX = 'V2_BATCH_LOOKUP_DEFERRED:';

export function isLookupDeferred(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith(LOOKUP_DEFERRED_PREFIX);
}
