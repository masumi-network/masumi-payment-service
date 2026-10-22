// OpenAPI docs for configuration weaknesses the admin UI warns about.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import { securityStatusOutput } from '@/routes/api/security-status';

export function registerSecurityStatusPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/security-status',
		summary: 'Report insecure service configuration.',
		description:
			'Reports whether ENCRYPTION_KEY is the public value from .env.example. The service still starts with that key, but anyone with a copy of the database can then decrypt every stored secret. The service has no tool to re-encrypt secrets: a new key on an existing database makes the stored secrets unreadable and every API key invalid. For production, start a new database with a private key. Admin access is required.',
		tags: ['health'],
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: successResponse('Security status', securityStatusOutput, { isEncryptionKeyPublic: false }),
			401: { description: 'Unauthorized' },
		},
	});
}
