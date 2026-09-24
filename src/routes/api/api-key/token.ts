import { createId } from '@paralleldrive/cuid2';

/**
 * Non-secret product prefix carried by every issued API key.
 *
 * It leaks nothing about the key holder and is what lets secret scanners
 * (GitHub, GitLab, gitleaks) fingerprint a leaked Masumi credential, so it stays.
 */
export const API_KEY_TOKEN_PREFIX = 'masumi-payment-';

/**
 * Mint the token string for a new API key.
 *
 * Deliberately takes no permission argument. The generator used to splice an
 * `admin-` segment in for admin keys, so a leaked `masumi-payment-admin-…` string
 * announced itself as the highest-privilege credential in the system while read
 * and pay keys carried no marker at all — a perfect classifier for anyone
 * triaging a dump of leaked secrets. Permissions are stored on the ApiKey row and
 * resolved from there by the auth middleware, which never parses the token, so
 * the token itself must stay opaque.
 */
export function generateApiKeyToken(): string {
	return API_KEY_TOKEN_PREFIX + createId();
}
