import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { transformBigIntAmounts } from '@/utils/shared/transformers';
import { apiKeyOutputSchema } from '@/routes/api/api-key';

const getAPIKeyStatusSchemaInput = z.object({});

export const getAPIKeyStatusSchemaOutput = apiKeyOutputSchema;

export const queryAPIKeyStatusEndpointGet =
  readAuthenticatedEndpointFactory.build({
    method: 'get',
    input: getAPIKeyStatusSchemaInput,
    output: getAPIKeyStatusSchemaOutput,
    handler: async ({ options }) => {
      const result = await prisma.apiKey.findFirst({
        where: { id: options.id },
        include: { RemainingUsageCredits: true },
      });
      if (!result) {
        throw createHttpError(404, 'API key not found');
      }
      return {
        ...result,
        RemainingUsageCredits: transformBigIntAmounts(
          result.RemainingUsageCredits,
        ),
      };
    },
  });
