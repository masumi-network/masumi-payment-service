import { unauthenticatedEndpointFactory } from '@/utils/security/auth/not-authenticated';
import { z } from '@/utils/zod-openapi';

export const healthResponseSchema = z.object({
  status: z
    .string()
    .describe('Health status of the service. Returns "ok" when the service is running'),
});

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
