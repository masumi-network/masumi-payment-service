import { readAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { apiKeyOutputSchema, mapApiKeyOutput } from '@/routes/api/api-key';

const getAPIKeyStatusSchemaInput = z.object({});

export const getAPIKeyStatusSchemaOutput = apiKeyOutputSchema;

export const queryAPIKeyStatusEndpointGet = readAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getAPIKeyStatusSchemaInput,
	output: getAPIKeyStatusSchemaOutput,
	handler: async ({ ctx }) => {
		const result = await prisma.apiKey.findFirst({
			where: { id: ctx.id },
			include: {
				RemainingUsageCredits: { select: { amount: true, unit: true } },
				WalletScopes: { select: { hotWalletId: true } },
			},
		});
		if (!result) {
			throw createHttpError(404, 'API key not found');
		}
		return mapApiKeyOutput(result);
	},
});
