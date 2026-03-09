import { unauthenticatedEndpointFactory } from '@/utils/security/auth/not-authenticated';
import { z } from '@/utils/zod-openapi';
import { healthResponseSchema } from './schemas';

export const healthEndpointGet = unauthenticatedEndpointFactory.build({
	method: 'get',
	input: z.object({}),
	output: healthResponseSchema,
	handler: async () => {
		return {
			status: 'ok',
		};
	},
});

export { healthResponseSchema } from './schemas';
