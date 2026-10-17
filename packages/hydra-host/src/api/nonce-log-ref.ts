import { createHash } from 'node:crypto';

const NONCE_LOG_REF_LENGTH = 12;

/**
 * A log-safe stand-in for an invite nonce. An open nonce is a bearer secret on
 * the Exchange Plane, so it must never reach a log. Same format as the
 * payment service's nonceLogRef, so lines from both sides correlate.
 */
export function nonceLogRef(nonce: string): string {
	return `sha256:${createHash('sha256').update(nonce).digest('hex').slice(0, NONCE_LOG_REF_LENGTH)}`;
}
