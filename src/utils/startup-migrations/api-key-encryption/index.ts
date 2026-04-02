import { prisma } from '@/utils/db';
import { encrypt } from '@/utils/security/encryption';
import { generateApiKeySecureHash } from '@/utils/crypto/api-key-hash';
import { logger } from '@/utils/logger';

/**
 * One-time startup migration: encrypts any plaintext API key tokens still in the DB.
 *
 * Idempotent — only processes rows where `token IS NOT NULL`.
 * Already-migrated rows (token = null) are skipped automatically.
 * Runs before the HTTP server accepts requests.
 */
export async function migrateApiKeyEncryption(): Promise<void> {
	const keysToMigrate = await prisma.apiKey.findMany({
		where: { token: { not: null } },
		select: { id: true, token: true },
	});

	if (keysToMigrate.length === 0) {
		return;
	}

	logger.info(`Migrating ${keysToMigrate.length} API key(s) to encrypted storage`, { component: 'migration' });

	for (const key of keysToMigrate) {
		if (!key.token) continue;
		await prisma.apiKey.update({
			where: { id: key.id },
			data: {
				encryptedToken: encrypt(key.token),
				tokenHashSecure: await generateApiKeySecureHash(key.token),
				token: null,
				tokenHash: null,
			},
		});
	}

	logger.info('API key migration complete', { component: 'migration' });
}
