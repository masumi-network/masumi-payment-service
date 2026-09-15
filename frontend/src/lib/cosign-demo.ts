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
  const isLoopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) return null;
  if (url.username || url.password) return null;
  return url.toString();
}

export const COSIGN_DASHBOARD_URL = parseCosignDashboardUrl(
  process.env.NEXT_PUBLIC_EXCHAIN_DASHBOARD_URL,
);
