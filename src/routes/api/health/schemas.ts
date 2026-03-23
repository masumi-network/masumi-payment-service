import { z } from '@/utils/zod-openapi';

export const healthResponseSchema = z.object({
	status: z.string().describe('Health status of the service. Returns "ok" when the service is running'),
});
