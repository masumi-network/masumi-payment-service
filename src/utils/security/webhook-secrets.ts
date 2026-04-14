import { generateSHA256Hash } from '@/utils/crypto';
import { decrypt, encrypt } from '@/utils/security/encryption';
import { logger } from '@/utils/logger';

export function generateWebhookUrlHash(url: string): string {
	return generateSHA256Hash(url);
}

export function encryptWebhookUrl(url: string): string {
	return encrypt(url);
}

export function encryptWebhookAuthToken(authToken: string | null | undefined): string | null {
	if (authToken == null) {
		return null;
	}

	return encrypt(authToken);
}

export function decryptWebhookUrlSafe(encryptedUrl: string): string {
	try {
		return decrypt(encryptedUrl);
	} catch (error) {
		logger.error('Webhook URL decryption failed', { error });
		return '';
	}
}

export function decryptWebhookUrlForDelivery(encryptedUrl: string): string | null {
	try {
		return decrypt(encryptedUrl);
	} catch (error) {
		logger.error('Webhook URL decryption failed', { error });
		return null;
	}
}

export function decryptWebhookAuthTokenSafe(encryptedAuthToken: string | null): string | null {
	if (!encryptedAuthToken) {
		return null;
	}

	try {
		return decrypt(encryptedAuthToken);
	} catch (error) {
		logger.error('Webhook auth token decryption failed', { error });
		return null;
	}
}
