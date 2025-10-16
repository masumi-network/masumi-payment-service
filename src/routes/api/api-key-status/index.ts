import { readAuthenticatedEndpointFactory } from '@/utils/security/auth/read-authenticated';
import { z } from 'zod';
import { ApiKeyStatus, Network, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import createHttpError from 'http-errors';

const getAPIKeyStatusSchemaInput = z.object({});

export const getAPIKeyStatusSchemaOutput = z.object({
  token: z.string(),
  permission: z.nativeEnum(Permission),
  usageLimited: z.boolean(),
  networkLimit: z.array(z.nativeEnum(Network)),
  RemainingUsageCredits: z.array(
    z.object({
      unit: z
        .string()
        .describe(
          "Cardano asset unit identifier. Use empty string '' for ADA/lovelace. For native tokens, concatenate policyId + assetName in hexadecimal format (e.g., '99e40070791314c489849b...6d7920746f6b656e' where first 56 chars are policyId).",
        ),
      amount: z
        .string()
        .describe(
          "Amount as an integer string in the token's smallest unit, including all decimals. For ADA (6 decimals): '10000000' = 10 ADA, '1000000' = 1 ADA. For custom tokens, multiply by 10^decimals. Never use decimal notation (e.g., '10.5').",
        ),
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
        RemainingUsageCredits: result?.RemainingUsageCredits.map(
          (usageCredit) => ({
            unit: usageCredit.unit,
            amount: usageCredit.amount.toString(),
          }),
        ),
      };
    },
  });
