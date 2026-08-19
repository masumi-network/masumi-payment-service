/**
 * API key capability flags used to gate the admin UI.
 * Prefer these over the deprecated `permission` enum from /api-key-status.
 */
export type ApiKeyCapabilities = {
  canRead: boolean;
  canPay: boolean;
  canAdmin: boolean;
  /**
   * The key's own CAIP-2 chain limit, straight from /api-key-status. Non-admin
   * keys only ever see x402 chains whose caip2Id is in this list, so an empty
   * EVM section is ambiguous without it — "the rail isn't set up" and "your key
   * has no EVM chain" look identical. Reporting the key's own limit explains the
   * second case without revealing whether any chain exists.
   */
  chainIdLimit: string[];
  /**
   * Whether this key is restricted to assigned managed EVM wallets. False (the
   * default) means unrestricted, matching the Cardano walletScopeEnabled flag —
   * so an empty wallet list means different things in the two cases.
   */
  x402WalletScopeEnabled: boolean;
};

export const DEFAULT_CAPABILITIES: ApiKeyCapabilities = {
  canRead: false,
  canPay: false,
  canAdmin: false,
  chainIdLimit: [],
  x402WalletScopeEnabled: false,
};

/** Whether the key's chain limit includes at least one EVM (eip155) chain. */
export function hasEvmChainLimit(chainIdLimit: string[]): boolean {
  return chainIdLimit.some((chainId) => chainId.toLowerCase().startsWith('eip155:'));
}

/** Routes that require canAdmin. Deep-links for non-admins are redirected away. */
export const ADMIN_ONLY_PATHS = [
  '/api-keys',
  '/tx-sync-quarantine',
  '/setup',
  '/x402-setup',
  '/payment-sources',
  // Every route under /api/v1/hydra is registered with the admin factory, so
  // this page has nothing a read or pay key can load.
  '/hydra-heads',
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
 * `/webhooks` qualifies: every webhooks endpoint, GET included, is
 * payAuthenticated.
 *
 * `/wallets` and `/x402` are deliberately absent. The wallets table is built
 * from GET /wallet/list and GET /balance, and the x402 page's chain projection
 * plus attempt/settlement history are read-level too, so every signed-in
 * session may view them. Their mutating controls, the per-wallet detail dialog
 * and the x402 wallet/chain/budget/alert tabs stay gated inside those pages.
 */
export const PAY_ONLY_PATHS = ['/webhooks'] as const;

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
        ChainIdLimit?: string[];
        x402WalletScopeEnabled?: boolean;
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
    chainIdLimit: data.ChainIdLimit ?? [],
    x402WalletScopeEnabled: data.x402WalletScopeEnabled === true,
  };
}
