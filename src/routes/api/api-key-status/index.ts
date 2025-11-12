import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import { ApiKeyStatus, Network, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';
import { transformBigIntAmounts } from '../../../utils/shared/transformers';

const getAPIKeyStatusSchemaInput = z.object({});

export const getAPIKeyStatusSchemaOutput = z.object({
  token: z.string(),
  permission: z.nativeEnum(Permission),
  usageLimited: z.boolean(),
  networkLimit: z.array(z.nativeEnum(Network)),
  RemainingUsageCredits: z.array(
    z.object({
      unit: z.string(),
      amount: z.string(),
    }),
  ),
  status: z.nativeEnum(ApiKeyStatus),
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
