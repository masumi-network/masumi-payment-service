import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { usesPublicEncryptionKey } from '@/utils/security/public-encryption-key';

export const securityStatusOutput = z.object({
	isEncryptionKeyPublic: z
		.boolean()
		.describe('True when ENCRYPTION_KEY is the public .env.example value. A database copy then exposes every secret.'),
});

// Admin only: the flag tells an attacker which key decrypts a leaked database.
export const securityStatusGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: z.object({}),
	output: securityStatusOutput,
	handler: async () => ({ isEncryptionKeyPublic: usesPublicEncryptionKey() }),
});
