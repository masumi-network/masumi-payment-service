import dotenv from 'dotenv';
import { CONFIG, DEFAULTS } from '@masumi/payment-core/config';

// The .env.example value is public, so a database copy encrypted with it is readable to anyone.
// `docker run --env-file` keeps the quotes and inline comment of that .env.example line, and the
// raw string is just as public. So compare the value as dotenv reads it.
export function usesPublicEncryptionKey(encryptionKey: string | undefined = CONFIG.ENCRYPTION_KEY): boolean {
	if (encryptionKey === undefined) return false;
	return dotenv.parse(`ENCRYPTION_KEY=${encryptionKey}`).ENCRYPTION_KEY === DEFAULTS.EXAMPLE_ENCRYPTION_KEY;
}
