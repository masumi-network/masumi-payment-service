import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { z } from '@/utils/zod-openapi';
import { ApiKeyStatus, Network, Permission } from '@prisma/client';
import { prisma } from '@/utils/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';
import { generateSHA256Hash } from '@/utils/crypto';
import { CONSTANTS } from '@/utils/config';
import { transformBigIntAmounts } from '@/utils/shared/transformers';

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

export const apiKeyOutputSchema = z
  .object({
    id: z.string().describe('Unique identifier for the API key'),
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
    status: z
      .nativeEnum(ApiKeyStatus)
      .describe('Current status of the API key'),
  })
  .openapi('APIKey');

export const getAPIKeySchemaOutput = z.object({
  ApiKeys: z.array(apiKeyOutputSchema).describe('List of API keys'),
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
      include: {
        RemainingUsageCredits: { select: { amount: true, unit: true } },
      },
    });
    return {
      ApiKeys: result.map((data) => ({
        ...data,
        RemainingUsageCredits: transformBigIntAmounts(
          data.RemainingUsageCredits,
        ),
      })),
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
            'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
          ),
        amount: z
          .string()
          .describe(
            'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
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

export const addAPIKeySchemaOutput = apiKeyOutputSchema;

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
        tokenHash: generateSHA256Hash(apiKey),
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
      include: {
        RemainingUsageCredits: { select: { amount: true, unit: true } },
      },
    });
    return {
      ...result,
      RemainingUsageCredits: transformBigIntAmounts(
        result.RemainingUsageCredits,
      ),
    };
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
            'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
          ),
        amount: z
          .string()
          .describe(
            'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
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

export const updateAPIKeySchemaOutput = apiKeyOutputSchema;

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
        async (prisma) => {
          const apiKey = await prisma.apiKey.findUnique({
            where: { id: input.id },
            include: {
              RemainingUsageCredits: {
                select: { id: true, amount: true, unit: true },
              },
            },
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
                  await prisma.unitValue.delete({
                    where: { id: existingCredit.id },
                  });
                } else if (existingCredit.amount < 0) {
                  throw createHttpError(400, 'Invalid amount');
                } else {
                  await prisma.unitValue.update({
                    where: { id: existingCredit.id },
                    data: { amount: existingCredit.amount },
                  });
                }
              } else {
                if (parsedAmount <= 0) {
                  throw createHttpError(400, 'Invalid amount');
                }
                await prisma.unitValue.create({
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
          const result = await prisma.apiKey.update({
            where: { id: input.id },
            data: {
              token: input.token,
              usageLimited: input.usageLimited,
              status: input.status,
              networkLimit: input.networkLimit,
            },
            include: {
              RemainingUsageCredits: { select: { amount: true, unit: true } },
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
      return {
        ...apiKey,
        RemainingUsageCredits: transformBigIntAmounts(
          apiKey.RemainingUsageCredits,
        ),
      };
    },
  });

export const deleteAPIKeySchemaInput = z.object({
  id: z
    .string()
    .max(150)
    .describe('The id of the API key to be (soft) deleted.'),
});

export const deleteAPIKeySchemaOutput = apiKeyOutputSchema;

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
      const apiKey = await prisma.apiKey.update({
        where: { id: input.id },
        data: { deletedAt: new Date(), status: ApiKeyStatus.Revoked },
        include: {
          RemainingUsageCredits: { select: { amount: true, unit: true } },
        },
      });
      return {
        ...apiKey,
        RemainingUsageCredits: transformBigIntAmounts(
          apiKey.RemainingUsageCredits,
        ),
      };
    },
  });
