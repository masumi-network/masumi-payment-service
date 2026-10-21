// OpenAPI docs for configuration weaknesses the admin UI warns about.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import { securityStatusOutput } from '@/routes/api/security-status';

export function registerSecurityStatusPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'get',
		path: '/security-status',
		summary: 'Report insecure service configuration.',
		description:
			'Reports whether ENCRYPTION_KEY is the public value from .env.example. The service still starts with that key, but anyone with a copy of the database can then decrypt wallet and Hydra Host secrets. Set a new key and re-encrypt the secrets before production use. Admin access is required.',
		tags: ['health'],
		security: [{ [apiKeyAuth.name]: [] }],
		responses: {
			200: successResponse('Security status', securityStatusOutput, { isEncryptionKeyPublic: false }),
			401: { description: 'Unauthorized' },
		},
	});
}
