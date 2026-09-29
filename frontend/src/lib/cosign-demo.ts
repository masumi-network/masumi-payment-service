/**
 * MAS-596 demo: the partner-hosted co-sign dashboard embedded by /cosign-demo.
 *
 * Inlined at build time. This check applies the same rule as the backend's
 * CSP frame-src parser (https, or http on localhost only). The backend fails
 * startup on a URL outside that rule; here such a URL is ignored and the page
 * shows its empty state.
 */
export function parseCosignDashboardUrl(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackUrl(url))) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

function isLoopbackUrl(url: URL): boolean {
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * Whether the page should ask the backend for an Exchain read token. A loopback
 * dashboard is the local mock, which issues no tokens, so asking only logs a 503.
 */
export function needsReadToken(dashboardUrl: string | null): boolean {
  return dashboardUrl != null && !isLoopbackUrl(new URL(dashboardUrl));
}

export const COSIGN_DASHBOARD_URL = parseCosignDashboardUrl(
  process.env.NEXT_PUBLIC_EXCHAIN_DASHBOARD_URL,
);
