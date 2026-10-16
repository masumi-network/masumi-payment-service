/**
 * Mint a known admin/pay API key in the test DB for the Layer-2 REST bench.
 * Prints the raw token on stdout (last line).
 *
 * Run: DATABASE_URL=<test-db> ENCRYPTION_KEY=... pnpm exec tsx hydra-l2-flow/mint-bench-api-key.mts
 */
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { prisma } from '@masumi/payment-core/db';
import { generateApiKeySecureHash } from '@masumi/payment-core/api-key-hash';
import { encrypt } from '@/utils/security/encryption';
import { ApiKeyStatus } from '@/generated/prisma/client';

async function main() {
	const token = `bench_${randomBytes(16).toString('hex')}`;
	const tokenHash = await generateApiKeySecureHash(token);
	const masked = `*****${token.slice(-4)}`;
	const existing = await prisma.apiKey.findFirst({ where: { tokenHash } });
	if (!existing) {
		await prisma.apiKey.create({
			data: {
				token: masked,
				tokenHash,
				encryptedToken: encrypt(token),
				canRead: true,
				canPay: true,
				canAdmin: true,
				status: ApiKeyStatus.Active,
				usageLimited: false,
				networkLimit: ['Preprod'],
			},
		});
	}
	// Write before exiting: prisma keeps the event loop alive, so callers that
	// capture stdout can hang waiting for a close that never comes.
	const out = process.env.API_KEY_OUT;
	if (out) writeFileSync(out, token);
	console.log(token);
	await prisma.$disconnect();
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
