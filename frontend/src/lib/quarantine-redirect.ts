import type { ParsedUrlQuery } from 'querystring';

export const QUARANTINE_CANONICAL_PATH = '/tx-sync-quarantine';
export const QUARANTINE_LEGACY_PATH = '/sync-quarantine';

/** Build the client redirect target for the legacy quarantine route. */
export function buildQuarantineRedirectTarget(query: ParsedUrlQuery = {}) {
  return {
    pathname: QUARANTINE_CANONICAL_PATH,
    query,
  };
}
