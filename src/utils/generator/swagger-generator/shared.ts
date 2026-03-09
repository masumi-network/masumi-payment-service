import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from '@/utils/zod-openapi';

export type SwaggerRegistrarContext = {
	registry: OpenAPIRegistry;
	apiKeyAuth: {
		name: string;
	};
};

const successEnvelopeSchema = (dataSchema: z.ZodTypeAny, dataExample: unknown) =>
	z.object({ status: z.literal('success'), data: dataSchema }).openapi({
		example: {
			status: 'success',
			data: dataExample,
		},
	});

export const successResponse = (description: string, dataSchema: z.ZodTypeAny, dataExample: unknown) => ({
	description,
	content: {
		'application/json': {
			schema: successEnvelopeSchema(dataSchema, dataExample),
		},
	},
});
