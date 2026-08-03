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
  '/wallets',
  '/tx-sync-quarantine',
  '/setup',
  '/x402-setup',
  '/payment-sources',
] as const;

export function isAdminOnlyPath(pathname: string): boolean {
  return (ADMIN_ONLY_PATHS as readonly string[]).includes(pathname);
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
