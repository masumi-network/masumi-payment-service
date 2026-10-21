// Mirrors DEFAULTS.DEFAULT_ADMIN_KEY and DEFAULTS.EXAMPLE_ADMIN_KEY in
// packages/payment-core/src/config.ts. The seed stores one of them as an admin
// key when ADMIN_KEY is unset or copied from .env.example (docs/security.md,
// Accepted Risks #4).
export const PUBLIC_ADMIN_KEYS: readonly string[] = [
  'DefaultUnsecureAdminKey',
  'abcdef_this_should_be_very_secure',
];

export function isPublicAdminKey(apiKey: string | null): boolean {
  return apiKey !== null && PUBLIC_ADMIN_KEYS.includes(apiKey);
}
