import { unauthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
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
