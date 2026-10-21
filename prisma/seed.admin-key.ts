import { ApiKeyStatus, PrismaClient } from '../src/generated/prisma/client';
import { encrypt } from './../src/utils/security/encryption';
import { DEFAULTS } from '@masumi/payment-core/config';
import { generateApiKeySecureHash } from '@masumi/payment-core/api-key-hash';
import { isPublicAdminKey } from './seed.public-secrets';

const MIN_ADMIN_KEY_LENGTH = 15;

/**
 * Falls back to the public DEFAULT_ADMIN_KEY, a bootstrap convenience.
 * Intended: see docs/security.md, Accepted Risks #4.
 */
export function resolveAdminKey(rawAdminKey: string | undefined): string {
	if (!rawAdminKey) {
		console.warn('ADMIN_KEY is not set: falling back to DEFAULT_ADMIN_KEY.');
		return DEFAULTS.DEFAULT_ADMIN_KEY;
	}
	if (rawAdminKey.length < MIN_ADMIN_KEY_LENGTH) {
		console.error(`ADMIN_KEY is insecure, ensure it is at least ${MIN_ADMIN_KEY_LENGTH} characters long`);
		throw Error('API-KEY is insecure');
	}
	return rawAdminKey;
}

export async function seedAdminKey(prisma: PrismaClient, adminKey: string): Promise<void> {
	const adminKeyHash = await generateApiKeySecureHash(adminKey);
	// SECURITY: Refuse to seed a public admin key (DEFAULT_ADMIN_KEY or the
	// .env.example value) when an admin already exists. Without this guard, an
	// operator who provisioned a real ADMIN_KEY, then later ran the seed script
	// without that env var set, would silently add a SECOND admin key (the
	// public one) alongside their real one — creating a public backdoor. Public
	// keys are intended as a bootstrap convenience for first-time empty
	// deployments only.
	if (isPublicAdminKey(adminKey)) {
		const existingAdminCount = await prisma.apiKey.count({
			where: { canAdmin: true, status: ApiKeyStatus.Active },
		});
		if (existingAdminCount > 0) {
			console.warn('****************************************************');
			console.warn('**  REFUSING to seed a public ADMIN_KEY — an admin **');
			console.warn('**  key already exists. Set ADMIN_KEY in .env to  **');
			console.warn('**  manage admin credentials explicitly.          **');
			console.warn('****************************************************');
			return;
		}
	}
	await prisma.apiKey.upsert({
		create: {
			encryptedToken: encrypt(adminKey),
			tokenHash: adminKeyHash,
			token: '*****' + adminKey.slice(-4),
			// Flag-based permissions (new system)
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
			// networkLimit is now a NOT NULL CAIP-2 String[] with no DB default (the
			// x402 migration dropped it). Admin keys store an empty list — auth grants
			// all networks regardless — mirroring addAPIKeyEndpointPost (`isAdmin ? []`).
			// Backwards compatible: the legacy Network[] column also defaulted to empty.
			networkLimit: [],
		},
		update: {
			encryptedToken: encrypt(adminKey),
			token: '*****' + adminKey.slice(-4),
			canRead: true,
			canPay: true,
			canAdmin: true,
			status: ApiKeyStatus.Active,
		},
		where: { tokenHash: adminKeyHash },
	});
	console.log(isPublicAdminKey(adminKey) ? 'Seeded with a public ADMIN_KEY' : 'ADMIN_KEY seeded successfully');
}
