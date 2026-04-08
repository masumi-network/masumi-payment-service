import { prisma } from '@/utils/db';
import { logger } from '@/utils/logger';
import { encryptWebhookAuthToken, encryptWebhookUrl, generateWebhookUrlHash } from '@/utils/security/webhook-secrets';

/**
 * One-time startup migration: encrypts webhook URLs/auth tokens for rows that do not yet have a urlHash.
 *
 * Idempotent — only processes rows where `urlHash IS NULL`.
 */
export async function migrateWebhookEncryption(): Promise<void> {
	const webhooksToMigrate = await prisma.webhookEndpoint.findMany({
		where: { urlHash: null },
		select: {
			id: true,
			url: true,
			authToken: true,
		},
	});

	if (webhooksToMigrate.length === 0) {
		return;
	}

	logger.info(`Migrating ${webhooksToMigrate.length} webhook endpoint(s) to encrypted storage`, {
		component: 'migration',
	});

	for (const webhook of webhooksToMigrate) {
		await prisma.webhookEndpoint.update({
			where: { id: webhook.id },
			data: {
				url: encryptWebhookUrl(webhook.url),
				authToken: encryptWebhookAuthToken(webhook.authToken),
				urlHash: generateWebhookUrlHash(webhook.url),
			},
		});
	}

	logger.info('Webhook encryption migration complete', { component: 'migration' });
}
