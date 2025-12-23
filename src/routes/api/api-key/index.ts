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
    allowedWalletIds: z
      .array(z.string())
      .optional()
      .describe(
        'List of wallet IDs this API key can access (only populated for WalletScoped keys)',
      ),
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
        RemainingUsageCredits: true,
        WalletScopedHotWallets: {
          where: {
            deletedAt: null,
          },
          select: {
            id: true,
          },
        },
      },
    });
    return {
      ApiKeys: result.map((data) => ({
        ...data,
        RemainingUsageCredits: transformBigIntAmounts(
          data.RemainingUsageCredits,
        ),
        allowedWalletIds:
          data.permission === Permission.WalletScoped
            ? data.WalletScopedHotWallets.map((wallet) => wallet.id)
            : undefined,
        WalletScopedHotWallets: undefined,
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
  hotWalletIds: z
    .array(z.string())
    .optional()
    .describe(
      'List of HotWallet IDs to assign to this API key. Required if permission is WalletScoped.',
    ),
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
    const isWalletScoped = input.permission === Permission.WalletScoped;

    if (isWalletScoped) {
      const hotWalletIds = input.hotWalletIds || [];

      if (hotWalletIds.length > 0) {
        const wallets = await prisma.hotWallet.findMany({
          where: {
            id: { in: hotWalletIds },
            deletedAt: null,
          },
          include: {
            PaymentSource: {
              select: {
                id: true,
                network: true,
                deletedAt: true,
              },
            },
          },
        });

        if (wallets.length !== hotWalletIds.length) {
          throw createHttpError(
            404,
            'One or more HotWallets not found or deleted',
          );
        }

        // Validate wallets belong to non-deleted PaymentSources
        const invalidWallets = wallets.filter(
          (w) => w.PaymentSource.deletedAt !== null,
        );
        if (invalidWallets.length > 0) {
          throw createHttpError(
            400,
            'One or more HotWallets belong to deleted PaymentSources',
          );
        }

        const assignedWallets = await prisma.hotWallet.findMany({
          where: {
            id: { in: hotWalletIds },
            walletScopedApiKeyId: { not: null },
          },
          select: {
            id: true,
            walletScopedApiKeyId: true,
          },
        });

        if (assignedWallets.length > 0) {
          throw createHttpError(
            400,
            `Wallets already assigned to another API key: ${assignedWallets.map((w) => w.id).join(', ')}`,
          );
        }

        // Auto-detect network from wallets
        const networks = new Set<Network>();
        for (const wallet of wallets) {
          networks.add(wallet.PaymentSource.network);
        }
        input.networkLimit = Array.from(networks);
      } else {
        input.networkLimit = [];
      }
    }

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
      include: { RemainingUsageCredits: true },
    });

    if (isWalletScoped && input.hotWalletIds && input.hotWalletIds.length > 0) {
      await prisma.hotWallet.updateMany({
        where: {
          id: { in: input.hotWalletIds },
        },
        data: {
          walletScopedApiKeyId: result.id,
        },
      });
    }

    return {
      ...result,
      RemainingUsageCredits: transformBigIntAmounts(
        result.RemainingUsageCredits,
      ),
      allowedWalletIds:
        isWalletScoped && input.hotWalletIds ? input.hotWalletIds : undefined,
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
  walletsToAdd: z
    .array(z.string())
    .optional()
    .describe(
      'Array of wallet IDs to assign to this WalletScoped API key. Only applicable for WalletScoped keys.',
    ),
  walletsToRemove: z
    .array(z.string())
    .optional()
    .describe(
      'Array of wallet IDs to unassign from this WalletScoped API key. Only applicable for WalletScoped keys.',
    ),
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
            include: { RemainingUsageCredits: true },
          });
          if (!apiKey) {
            throw createHttpError(404, 'API key not found');
          }

          if (input.walletsToAdd && input.walletsToAdd.length > 0) {
            if (apiKey.permission !== Permission.WalletScoped) {
              throw createHttpError(
                400,
                'Can only add wallets to WalletScoped API keys',
              );
            }

            const walletsToAdd = await prisma.hotWallet.findMany({
              where: {
                id: { in: input.walletsToAdd },
                deletedAt: null,
              },
            });

            if (walletsToAdd.length !== input.walletsToAdd.length) {
              throw createHttpError(
                404,
                'One or more wallets not found or deleted',
              );
            }

            const alreadyAssigned = await prisma.hotWallet.findMany({
              where: {
                id: { in: input.walletsToAdd },
                walletScopedApiKeyId: { not: null },
              },
              select: {
                id: true,
                walletScopedApiKeyId: true,
              },
            });

            if (alreadyAssigned.length > 0) {
              throw createHttpError(
                400,
                `Wallets already assigned to another API key: ${alreadyAssigned.map((w) => w.id).join(', ')}`,
              );
            }

            await prisma.hotWallet.updateMany({
              where: {
                id: { in: input.walletsToAdd },
              },
              data: {
                walletScopedApiKeyId: apiKey.id,
              },
            });
          }

          if (input.walletsToRemove && input.walletsToRemove.length > 0) {
            if (apiKey.permission !== Permission.WalletScoped) {
              throw createHttpError(
                400,
                'Can only remove wallets from WalletScoped API keys',
              );
            }

            const walletsToRemove = await prisma.hotWallet.findMany({
              where: {
                id: { in: input.walletsToRemove },
                walletScopedApiKeyId: apiKey.id,
              },
            });

            if (walletsToRemove.length !== input.walletsToRemove.length) {
              throw createHttpError(
                400,
                'One or more wallets do not belong to this API key',
              );
            }

            await prisma.hotWallet.updateMany({
              where: {
                id: { in: input.walletsToRemove },
              },
              data: {
                walletScopedApiKeyId: null,
              },
            });
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
              RemainingUsageCredits: true,
              WalletScopedHotWallets: {
                where: {
                  deletedAt: null,
                },
                select: {
                  id: true,
                },
              },
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
        allowedWalletIds:
          apiKey.permission === Permission.WalletScoped
            ? apiKey.WalletScopedHotWallets.map((wallet) => wallet.id)
            : undefined,
        WalletScopedHotWallets: undefined,
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
      await prisma.hotWallet.updateMany({
        where: { walletScopedApiKeyId: input.id },
        data: { walletScopedApiKeyId: null },
      });

      const apiKey = await prisma.apiKey.update({
        where: { id: input.id },
        data: { deletedAt: new Date(), status: ApiKeyStatus.Revoked },
        include: { RemainingUsageCredits: true },
      });
      return {
        ...apiKey,
        RemainingUsageCredits: transformBigIntAmounts(
          apiKey.RemainingUsageCredits,
        ),
        allowedWalletIds: undefined, // No wallets after deletion
      };
    },
  });
