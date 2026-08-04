import type { RailReadiness } from '@/lib/api/generated';

export type RailReadinessRail = RailReadiness['Rails'][number];
export type RailReadinessCheck = RailReadinessRail['Checks'][number];
export type RailReadinessCheckId = RailReadinessCheck['id'];

/** The readiness block for one rail, or null while it is unknown. */
export function railOf(
  readiness: RailReadiness | null | undefined,
  rail: RailReadinessRail['rail'],
): RailReadinessRail | null {
  return readiness?.Rails.find((entry) => entry.rail === rail) ?? null;
}

/**
 * Whether the backend reports a check as complete.
 *
 * Returns false for an unknown rail or check id, so a UI step can never render
 * as done just because the readiness payload has not arrived (or the id was
 * renamed server-side). Callers that need to distinguish "not ready" from "not
 * known yet" should gate on the query's loading state.
 */
export function isCheckComplete(
  rail: RailReadinessRail | null | undefined,
  id: RailReadinessCheckId,
): boolean {
  return rail?.Checks.find((check) => check.id === id)?.isComplete ?? false;
}

/** Every listed check complete — used for multi-check setup steps. */
export function areChecksComplete(
  rail: RailReadinessRail | null | undefined,
  ids: RailReadinessCheckId[],
): boolean {
  return ids.every((id) => isCheckComplete(rail, id));
}

/** The backend's explanation for a check, when it offered one. */
export function checkDetail(
  rail: RailReadinessRail | null | undefined,
  id: RailReadinessCheckId,
): string | null {
  return rail?.Checks.find((check) => check.id === id)?.detail ?? null;
}
