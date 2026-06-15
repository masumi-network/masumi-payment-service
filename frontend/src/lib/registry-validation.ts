export const REGISTRY_LIMITS = {
  agentName: 250,
  apiBaseUrl: 250,
  authorContact: 250,
  authorName: 250,
  capabilityName: 250,
  capabilityVersion: 250,
  description: 250,
  exampleOutputCount: 25,
  exampleOutputMimeType: 60,
  exampleOutputName: 60,
  exampleOutputUrl: 250,
  legalUrl: 250,
  lovelaceAmount: 25,
  pricingOptionCount: 5,
  tag: 63,
  tagCount: 15,
  walletReference: 250,
} as const;

export const INBOX_REGISTRY_LIMITS = {
  agentName: 120,
  agentSlug: 80,
  description: 500,
  lovelaceAmount: 25,
  walletReference: 250,
} as const;

export const REGISTRY_DECIMAL_ADA_AMOUNT_PATTERN = /^\d+(\.\d{1,6})?$/;

// Client-side apiBaseUrl validation shared between registration and migration.
// Mirrors the zod rules in RegisterAIAgentDialog (valid URL, <= 250 chars, must
// be http(s)) so an override can't pass the UI and only fail when postRegistry
// runs. Returns an error message, or null when the value is acceptable.
export function validateApiBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'API URL is required';
  try {
    new URL(trimmed);
  } catch {
    return 'API URL must be a valid URL';
  }
  if (trimmed.length > REGISTRY_LIMITS.apiBaseUrl) {
    return 'API URL must be less than 250 characters';
  }
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
    return 'API URL must start with http:// or https://';
  }
  return null;
}

export const RESERVED_INBOX_SLUGS = ['favicon.ico', 'robots.txt', 'sitemap.xml'] as const;

function stripDiacritics(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeInboxSlug(value: string) {
  return stripDiacritics(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

const normalizedReservedInboxSlugs = new Set(
  RESERVED_INBOX_SLUGS.map((slug) => normalizeInboxSlug(slug)),
);

export function isReservedInboxSlug(slug: string) {
  return normalizedReservedInboxSlugs.has(normalizeInboxSlug(slug));
}
