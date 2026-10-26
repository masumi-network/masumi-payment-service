import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { sealInviteNonce, sealInviteSignature } from '@/services/hydra-invite/invite-secrets';

/** Encrypt pre-existing invite bearer material before routes and jobs start. */
export async function migrateHydraInviteEncryption(): Promise<void> {
	const legacy = await prisma.hydraHeadInvite.findMany({
		where: { nonceHash: null },
		select: { id: true, nonce: true, issuerSignature: true },
	});
	for (const row of legacy) {
		const updated = await prisma.hydraHeadInvite.updateMany({
			where: { id: row.id, nonceHash: null },
			data: {
				...sealInviteNonce(row.nonce),
				issuerSignature: sealInviteSignature(row.issuerSignature),
			},
		});
		if (updated.count !== 1) {
			// Another instance may have completed this row while this one waited.
			const current = await prisma.hydraHeadInvite.findUnique({ where: { id: row.id }, select: { nonceHash: true } });
			if (current?.nonceHash == null) throw new Error(`Hydra invite encryption backfill failed for ${row.id}`);
		}
	}
	const remaining = await prisma.hydraHeadInvite.count({ where: { nonceHash: null } });
	if (remaining !== 0) throw new Error(`Hydra invite encryption backfill left ${remaining} plaintext row(s)`);
	if (legacy.length > 0) logger.info(`Encrypted ${legacy.length} legacy Hydra invite(s)`, { component: 'migration' });
}
