/**
 * API key capability flags used to gate the admin UI.
 * Prefer these over the deprecated `permission` enum from /api-key-status.
 */
export type ApiKeyCapabilities = {
  canRead: boolean;
  canPay: boolean;
  canAdmin: boolean;
};

export const DEFAULT_CAPABILITIES: ApiKeyCapabilities = {
  canRead: false,
  canPay: false,
  canAdmin: false,
};

/** Routes that require canAdmin. Deep-links for non-admins are redirected away. */
export const ADMIN_ONLY_PATHS = [
  '/api-keys',
  '/tx-sync-quarantine',
  '/setup',
  '/x402-setup',
  '/payment-sources',
] as const;

export function isAdminOnlyPath(pathname: string): boolean {
  return (ADMIN_ONLY_PATHS as readonly string[]).includes(pathname);
}

/**
 * Routes whose every backing endpoint is pay-authenticated. Read-only keys are
 * redirected away rather than left on the page: the 401s are swallowed by the
 * query layer, so an ungated route renders as a plausible-looking empty state
 * instead of telling the operator they lack permission.
 *
 * `/webhooks` belongs here for the same reason `/x402` does — GET /webhooks is
 * payAuthenticated, not read.
 *
 * `/wallets` is deliberately absent: its table is built from GET /wallet/list
 * and GET /balance, both read-level, so every signed-in session may view it.
 * The mutating controls and the per-wallet detail dialog hit admin-only
 * endpoints and stay gated on canAdmin inside the page.
 */
export const PAY_ONLY_PATHS = ['/x402', '/webhooks'] as const;

export function isPayOnlyPath(pathname: string): boolean {
  return (PAY_ONLY_PATHS as readonly string[]).includes(pathname);
}

export function capabilitiesFromApiKeyStatus(
  data:
    | {
        canRead?: boolean;
        canPay?: boolean;
        canAdmin?: boolean;
        status?: string;
      }
    | null
    | undefined,
): ApiKeyCapabilities | null {
  if (!data || data.status !== 'Active') {
    return null;
  }
  // Any active key used by the UI must at least be able to read.
  if (data.canRead !== true && data.canPay !== true && data.canAdmin !== true) {
    return null;
  }
  return {
    canRead: data.canRead === true || data.canPay === true || data.canAdmin === true,
    canPay: data.canPay === true || data.canAdmin === true,
    canAdmin: data.canAdmin === true,
  };
}
