import { generateSHA256Hash } from '@/utils/crypto';
import { decrypt, encrypt } from '@/utils/security/encryption';

type InviteNonceRow = { nonce: string; nonceHash?: string | null };
type InviteSignatureRow = { issuerSignature: string; nonceHash?: string | null };

/** The nonce is random and high entropy. Its digest is only an equality index. */
export function hashInviteNonce(nonce: string): string {
	return generateSHA256Hash(nonce);
}

export function sealInviteNonce(nonce: string): { nonce: string; nonceHash: string } {
	return { nonce: encrypt(nonce), nonceHash: hashInviteNonce(nonce) };
}

/** Null marks an unmigrated legacy row. Startup encrypts all such rows. */
export function revealInviteNonce(row: InviteNonceRow): string {
	if (row.nonceHash == null) return row.nonce;
	const nonce = decrypt(row.nonce);
	if (hashInviteNonce(nonce) !== row.nonceHash) {
		throw new Error('stored Hydra invite nonce does not match its lookup hash');
	}
	return nonce;
}

export function sealInviteSignature(signature: string): string {
	return encrypt(signature);
}

export function revealInviteSignature(row: InviteSignatureRow): string {
	return row.nonceHash == null ? row.issuerSignature : decrypt(row.issuerSignature);
}
