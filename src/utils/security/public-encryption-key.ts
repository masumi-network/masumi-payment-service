import { CONFIG, DEFAULTS } from '@masumi/payment-core/config';

// The .env.example value is public, so a database copy encrypted with it is readable to anyone.
export function usesPublicEncryptionKey(encryptionKey: string | undefined = CONFIG.ENCRYPTION_KEY): boolean {
	return encryptionKey?.trim() === DEFAULTS.EXAMPLE_ENCRYPTION_KEY;
}
