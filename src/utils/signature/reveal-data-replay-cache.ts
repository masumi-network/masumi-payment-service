import { createHash } from 'node:crypto';

const seenSignatures = new Map<string, number>();

export function markRevealSignatureUsed(input: {
	signature: string;
	key: string;
	blockchainIdentifier: string;
	validUntil: number;
}): boolean {
	const digest = createHash('sha256')
		.update(`${input.blockchainIdentifier}\0${input.key}\0${input.signature}`)
		.digest('hex');
	const now = Date.now();
	if (seenSignatures.has(digest)) {
		return false;
	}
	seenSignatures.set(digest, input.validUntil);
	for (const [key, expiresAt] of seenSignatures) {
		if (expiresAt < now) {
			seenSignatures.delete(key);
		}
	}
	return true;
}
