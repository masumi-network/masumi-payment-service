import crypto from 'crypto';
import { CONFIG } from '@/utils/config';

// Memoized salt: scryptSync is expensive; compute once from ENCRYPTION_KEY and reuse.
// The salt is deployment-specific (tied to ENCRYPTION_KEY) but deterministic,
// so the same token always produces the same hash — enabling findUnique DB lookups.
let _apiKeySalt: Buffer | undefined;
const _getApiKeySalt = (): Buffer => {
	if (!_apiKeySalt) {
		_apiKeySalt = crypto.scryptSync(CONFIG.ENCRYPTION_KEY, 'masumi-apikey-pbkdf2-salt-v1', 32);
	}
	return _apiKeySalt;
};

// Async PBKDF2-SHA512 with 100k iterations — computationally resistant to brute force.
// Async to avoid blocking the Node.js event loop (~50-100ms per call at 100k iterations).
// Deterministic per deployment: same token + same ENCRYPTION_KEY → same hash.
const generateApiKeySecureHash = (token: string): Promise<string> => {
	const salt = _getApiKeySalt();
	return new Promise((resolve, reject) => {
		crypto.pbkdf2(token, salt, 100_000, 64, 'sha512', (err, derivedKey) => {
			if (err) reject(err);
			else resolve(derivedKey.toString('hex'));
		});
	});
};

export { generateApiKeySecureHash };
