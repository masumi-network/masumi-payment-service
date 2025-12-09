import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import { ApiKeyStatus, Network, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { transformBigIntAmounts } from '@/utils/shared/transformers';

const getAPIKeyStatusSchemaInput = z.object({});

export const getAPIKeyStatusSchemaOutput = z.object({
  token: z.string().describe('The API key token'),
  permission: z
    .nativeEnum(Permission)
    .describe('Permission level of the API key'),
  usageLimited: z.boolean().describe('Whether the API key has usage limits'),
  networkLimit: z
    .array(z.nativeEnum(Network))
    .describe('List of Cardano networks this API key is allowed to access'),
  RemainingUsageCredits: z
    .array(
      z.object({
        unit: z
          .string()
          .describe(
            'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
          ),
        amount: z
          .string()
          .describe(
            'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
          ),
      }),
    )
    .describe('Remaining usage credits for this API key'),
  status: z.nativeEnum(ApiKeyStatus).describe('Current status of the API key'),
});

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
