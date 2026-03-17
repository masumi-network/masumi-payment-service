import crypto from 'crypto';
import { CONFIG } from '@/utils/config';

const generateSHA256Hash = (data: string) => {
	return crypto.createHash('sha256').update(data).digest('hex');
};

const generateHash = generateSHA256Hash;

let _apiKeySalt: Buffer | undefined;
const _getApiKeySalt = (): Buffer => {
	if (!_apiKeySalt) {
		_apiKeySalt = crypto.scryptSync(CONFIG.ENCRYPTION_KEY, 'masumi-apikey-pbkdf2-salt-v1', 32);
	}
	return _apiKeySalt;
};

const generateApiKeySecureHash = (token: string): Promise<string> => {
	const salt = _getApiKeySalt();
	return new Promise((resolve, reject) => {
		crypto.pbkdf2(token, salt, 100_000, 64, 'sha512', (err, derivedKey) => {
			if (err) reject(err);
			else resolve(derivedKey.toString('hex'));
		});
	});
};

export { generateHash, generateSHA256Hash, generateApiKeySecureHash };
