import { generateSHA256Hash } from '@/utils/crypto';

const NONCE_LOG_REF_LENGTH = 12;

/**
 * A log-safe stand-in for an invite nonce. An open nonce is a bearer secret:
 * the public Exchange Plane redeems it for anyone who signs with their own
 * wallet, so a log reader must never see it. The digest is one-way but stable,
 * so operators can still correlate log lines by hashing a nonce from the DB.
 */
export function nonceLogRef(nonce: string): string {
	return `sha256:${generateSHA256Hash(nonce).slice(0, NONCE_LOG_REF_LENGTH)}`;
}
