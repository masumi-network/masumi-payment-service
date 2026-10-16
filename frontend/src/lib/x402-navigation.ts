import type { ActiveRail } from '@/lib/contexts/AppContext';

export const X402_DASHBOARD_PATH = '/x402/dashboard';
export const X402_SETUP_PATH = '/x402-setup';

export const CARDANO_ONLY_PATHS = [
  '/',
  '/inbox-agents',
  '/wallets',
  '/transactions',
  '/invoices',
] as const;

type NavigationQuery = Record<string, string | string[] | undefined>;

export type NavigationTarget = {
  pathname: string;
  query: NavigationQuery;
};

const LEGACY_TAB_PATHS: Record<string, string> = {
  alerts: '/x402/wallets',
  budgets: '/x402/wallets',
  chains: '/payment-sources',
  dashboard: X402_DASHBOARD_PATH,
  payments: '/x402/payments',
  transactions: '/x402/payments',
  wallets: '/x402/wallets',
};

const COMPATIBILITY_PATHS: Record<string, string> = {
  '/x402/alerts': '/x402/wallets',
  '/x402/budgets': '/x402/wallets',
  '/x402/chains': '/payment-sources',
};

function withoutQueryField(query: NavigationQuery, field: string): NavigationQuery {
  return Object.fromEntries(Object.entries(query).filter(([key]) => key !== field));
}

export function legacyX402Target(query: NavigationQuery): NavigationTarget {
  const rawTab = Array.isArray(query.tab) ? query.tab[0] : query.tab;
  const pathname = rawTab ? LEGACY_TAB_PATHS[rawTab.toLowerCase()] : undefined;

  return {
    pathname: pathname ?? X402_DASHBOARD_PATH,
    query: withoutQueryField(query, 'tab'),
  };
}

export function compatibilityX402Target(
  pathname: keyof typeof COMPATIBILITY_PATHS,
  query: NavigationQuery,
): NavigationTarget {
  return {
    pathname: COMPATIBILITY_PATHS[pathname],
    query,
  };
}

export function isX402RailPath(pathname: string): boolean {
  return pathname === '/x402' || pathname.startsWith('/x402/') || pathname === X402_SETUP_PATH;
}

/**
 * Whether a session sitting on an x402 route should have the EVM rail restored.
 *
 * This exists for deep links: someone opens /x402/wallets with a persisted Cardano rail
 * and the sidebar has to follow the page. It must NOT fire for the opposite case, where
 * someone standing on an x402 page picks a Cardano source in the sidebar, because the
 * rail is then already 'cardano' while `pathname` still points at the old page for one
 * render.
 *
 * `isRouteChanging` was meant to cover that window and cannot. Next emits
 * `routeChangeStart` only after an `await matchesMiddleware(...)` inside `router.push`,
 * so the flag is still false when React flushes the click's effects. The switch was
 * therefore reverted to x402, and the pending navigation to '/' then landed on a
 * Cardano-only page with the rail restored, which bounced it on to /x402/dashboard.
 * `railJustSwitchedAway` closes the window with a value that is known synchronously.
 */
export function shouldRestoreX402Rail(
  pathname: string,
  areChainsLoading: boolean,
  availableChainCount: number,
  isRouteChanging = false,
  railJustSwitchedAway = false,
): boolean {
  return (
    isX402RailPath(pathname) &&
    !isRouteChanging &&
    !railJustSwitchedAway &&
    !areChainsLoading &&
    availableChainCount > 0
  );
}

export function deniedPathFallback(pathname: string, fallback: string): string {
  return isX402RailPath(pathname) ? X402_DASHBOARD_PATH : fallback;
}

export function railHomePath(activeRail: ActiveRail): string {
  return activeRail === 'x402' ? X402_DASHBOARD_PATH : '/';
}

export function setupPath(activeRail: ActiveRail, pathname: string): '/setup' | '/x402-setup' {
  if (pathname === '/setup') return '/setup';
  if (pathname === X402_SETUP_PATH) return X402_SETUP_PATH;
  return activeRail === 'x402' ? X402_SETUP_PATH : '/setup';
}

export function isSetupPath(pathname: string): boolean {
  return pathname === '/setup' || pathname === X402_SETUP_PATH;
}
