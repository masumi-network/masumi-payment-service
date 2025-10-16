import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from 'zod';
import { ApiKeyStatus, Network, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';
import { generateHash } from '@/utils/crypto';
import { CONSTANTS } from '@/utils/config';

export const getAPIKeySchemaInput = z.object({
  limit: z
    .number({ coerce: true })
    .min(1)
    .max(100)
    .default(10)
    .describe('The number of API keys to return'),
  cursorToken: z
    .string()
    .max(550)
    .optional()
    .describe('Used to paginate through the API keys'),
});

export const getAPIKeySchemaOutput = z.object({
  ApiKeys: z.array(
    z.object({
      id: z.string(),
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
    }),
  ),
});

export const queryAPIKeyEndpointGet = adminAuthenticatedEndpointFactory.build({
  method: 'get',
  input: getAPIKeySchemaInput,
  output: getAPIKeySchemaOutput,
  handler: async ({
    input,
  }: {
    input: z.infer<typeof getAPIKeySchemaInput>;
  }) => {
    const result = await prisma.apiKey.findMany({
      cursor: input.cursorToken ? { token: input.cursorToken } : undefined,
      take: input.limit,
      include: { RemainingUsageCredits: true },
    });
    return {
      ApiKeys: result.map((data) => {
        return {
          ...data,
          RemainingUsageCredits: data.RemainingUsageCredits.map(
            (usageCredit) => ({
              unit: usageCredit.unit,
              amount: usageCredit.amount.toString(),
            }),
          ),
        };
      }),
    };
  },
});

export const addAPIKeySchemaInput = z.object({
  usageLimited: z
    .string()
    .transform((s) => (s.toLowerCase() == 'true' ? true : false))
    .default('true')
    .describe(
      'Whether the API key is usage limited. Meaning only allowed to use the specified credits or can freely spend',
    ),
  UsageCredits: z
    .array(
      z.object({
        unit: z
          .string()
          .max(150)
          .describe(
            "Cardano asset unit identifier. Use empty string '' for ADA/lovelace. For native tokens, concatenate policyId + assetName in hexadecimal format (e.g., '99e40070791314c489849b...6d7920746f6b656e' where first 56 chars are policyId).",
          ),
        amount: z
          .string()
          .describe(
            "Amount as an integer string in the token's smallest unit, including all decimals. For ADA (6 decimals): '10000000' = 10 ADA, '1000000' = 1 ADA. For custom tokens, multiply by 10^decimals. Never use decimal notation (e.g., '10.5').",
          ),
      }),
    )
    .describe(
      'The credits allowed to be used by the API key. Only relevant if usageLimited is true. ',
    ),
  networkLimit: z
    .array(z.nativeEnum(Network))
    .max(3)
    .default([Network.Mainnet, Network.Preprod])
    .describe('The networks the API key is allowed to use'),
  permission: z
    .nativeEnum(Permission)
    .default(Permission.Read)
    .describe('The permission of the API key'),
});

export const addAPIKeySchemaOutput = z.object({
  id: z.string(),
  token: z.string(),
  permission: z.nativeEnum(Permission),
  usageLimited: z.boolean(),
  networkLimit: z.array(z.nativeEnum(Network)),
  status: z.nativeEnum(ApiKeyStatus),
});

export const addAPIKeyEndpointPost = adminAuthenticatedEndpointFactory.build({
  method: 'post',
  input: addAPIKeySchemaInput,
  output: addAPIKeySchemaOutput,
  handler: async ({
    input,
  }: {
    input: z.infer<typeof addAPIKeySchemaInput>;
  }) => {
    const isAdmin = input.permission == Permission.Admin;
    const apiKey = 'masumi-payment-' + (isAdmin ? 'admin-' : '') + createId();
    const result = await prisma.apiKey.create({
      data: {
        token: apiKey,
        tokenHash: generateHash(apiKey),
        status: ApiKeyStatus.Active,
        permission: input.permission,
        usageLimited: isAdmin ? false : input.usageLimited,
        networkLimit: isAdmin
          ? [Network.Mainnet, Network.Preprod]
          : input.networkLimit,
        RemainingUsageCredits: {
          createMany: {
            data: input.UsageCredits.map((usageCredit) => {
              const parsedAmount = BigInt(usageCredit.amount);
              if (parsedAmount < 0) {
                throw createHttpError(400, 'Invalid amount');
              }
              return { unit: usageCredit.unit, amount: parsedAmount };
            }),
          },
        },
      },
    });
    return result;
  },
});

export const updateAPIKeySchemaInput = z.object({
  id: z
    .string()
    .max(150)
    .describe('The id of the API key to update. Provide either id or apiKey'),
  token: z
    .string()
    .min(15)
    .max(550)
    .optional()
    .describe('To change the api key token'),
  UsageCreditsToAddOrRemove: z
    .array(
      z.object({
        unit: z
          .string()
          .max(150)
          .describe(
            "Cardano asset unit identifier. Use empty string '' for ADA/lovelace. For native tokens, concatenate policyId + assetName in hexadecimal format (e.g., '99e40070791314c489849b...6d7920746f6b656e' where first 56 chars are policyId).",
          ),
        amount: z
          .string()
          .describe(
            "Amount as an integer string in the token's smallest unit, including all decimals. Use positive values to add credits, negative values to remove credits. For ADA (6 decimals): '10000000' = 10 ADA, '-1000000' = -1 ADA. For custom tokens, multiply by 10^decimals. Never use decimal notation (e.g., '10.5').",
          ),
      }),
    )
    .max(25)
    .optional()
    .describe(
      'The amount of credits to add or remove from the API key. Only relevant if usageLimited is true. ',
    ),
  usageLimited: z
    .boolean()
    .default(true)
    .optional()
    .describe('Whether the API key is usage limited'),
  status: z
    .nativeEnum(ApiKeyStatus)
    .default(ApiKeyStatus.Active)
    .optional()
    .describe('The status of the API key'),
  networkLimit: z
    .array(z.nativeEnum(Network))
    .max(3)
    .default([Network.Mainnet, Network.Preprod])
    .optional()
    .describe('The networks the API key is allowed to use'),
});

export const updateAPIKeySchemaOutput = z.object({
  id: z.string(),
  token: z.string(),
  permission: z.nativeEnum(Permission),
  networkLimit: z.array(z.nativeEnum(Network)),
  usageLimited: z.boolean(),
  status: z.nativeEnum(ApiKeyStatus),
});

export const updateAPIKeyEndpointPatch =
  adminAuthenticatedEndpointFactory.build({
    method: 'patch',
    input: updateAPIKeySchemaInput,
    output: updateAPIKeySchemaOutput,
    handler: async ({
      input,
    }: {
      input: z.infer<typeof updateAPIKeySchemaInput>;
    }) => {
      const apiKey = await prisma.$transaction(
        async (tx) => {
          const apiKey = await tx.apiKey.findUnique({
            where: { id: input.id },
            include: { RemainingUsageCredits: true },
          });
          if (!apiKey) {
            throw createHttpError(404, 'API key not found');
          }
          if (input.UsageCreditsToAddOrRemove) {
            for (const usageCredit of input.UsageCreditsToAddOrRemove) {
              const parsedAmount = BigInt(usageCredit.amount);
              const existingCredit = apiKey.RemainingUsageCredits.find(
                (credit) => credit.unit == usageCredit.unit,
              );
              if (existingCredit) {
                existingCredit.amount += parsedAmount;
                if (existingCredit.amount == 0n) {
                  await tx.unitValue.delete({
                    where: { id: existingCredit.id },
                  });
                } else if (existingCredit.amount < 0) {
                  throw createHttpError(400, 'Invalid amount');
                } else {
                  await tx.unitValue.update({
                    where: { id: existingCredit.id },
                    data: { amount: existingCredit.amount },
                  });
                }
              } else {
                if (parsedAmount <= 0) {
                  throw createHttpError(400, 'Invalid amount');
                }
                await tx.unitValue.create({
                  data: {
                    unit: usageCredit.unit,
                    amount: parsedAmount,
                    apiKeyId: apiKey.id,
                    agentFixedPricingId: null,
                    paymentRequestId: null,
                    purchaseRequestId: null,
                  },
                });
              }
            }
          }
          const result = await tx.apiKey.update({
            where: { id: input.id },
            data: {
              token: input.token,
              usageLimited: input.usageLimited,
              status: input.status,
              networkLimit: input.networkLimit,
            },
          });
          return result;
        },
        {
          timeout: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
          maxWait: CONSTANTS.TRANSACTION_WAIT.SERIALIZABLE,
          isolationLevel: 'Serializable',
        },
      );
      return apiKey;
    },
  });

export const deleteAPIKeySchemaInput = z.object({
  id: z
    .string()
    .max(150)
    .describe('The id of the API key to be (soft) deleted.'),
});

export const deleteAPIKeySchemaOutput = z.object({
  id: z.string(),
  token: z.string(),
  permission: z.nativeEnum(Permission),
  usageLimited: z.boolean(),
  networkLimit: z.array(z.nativeEnum(Network)),
  status: z.nativeEnum(ApiKeyStatus),
  deletedAt: z.date().nullable(),
});

export const deleteAPIKeyEndpointDelete =
  adminAuthenticatedEndpointFactory.build({
    method: 'delete',
    input: deleteAPIKeySchemaInput,
    output: deleteAPIKeySchemaOutput,
    handler: async ({
      input,
    }: {
      input: z.infer<typeof deleteAPIKeySchemaInput>;
    }) => {
      return await prisma.apiKey.update({
        where: { id: input.id },
        data: { deletedAt: new Date(), status: ApiKeyStatus.Revoked },
      });
    },
  });
