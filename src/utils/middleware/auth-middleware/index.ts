import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import { prisma } from '@/utils/db';
import { z } from '@/utils/zod-openapi';
import { Permission, ApiKeyStatus, Network } from '@prisma/client';
import { generateSHA256Hash } from '@/utils/crypto';

export const authMiddleware = (minPermission: Permission) =>
  new Middleware({
    security: {
      // this information is optional and used for generating documentation
      type: 'header',
      name: 'api-key',
    },
    input: z.object({}),
    handler: async ({ request, logger }) => {
      try {
        const sentKey = request.headers.token;
        if (!sentKey || typeof sentKey !== 'string' || sentKey.length < 1) {
          throw createHttpError(
            401,
            'Unauthorized, no authentication token provided',
          );
        }

        const apiKey = await prisma.apiKey.findUnique({
          where: {
            tokenHash: generateSHA256Hash(sentKey),
          },
          include: {
            ApiKeyHotWallets: {
              where: {
                HotWallet: {
                  deletedAt: null,
                },
              },
              include: {
                HotWallet: {
                  include: {
                    PaymentSource: {
                      select: {
                        network: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });

        if (!apiKey) {
          throw createHttpError(
            401,
            'Unauthorized, invalid authentication token provided',
          );
        }

        if (apiKey.status !== ApiKeyStatus.Active) {
          throw createHttpError(401, 'Unauthorized, API key is revoked');
        }

        if (minPermission == Permission.Admin) {
          if (apiKey.permission === Permission.WalletScoped) {
            throw createHttpError(
              403,
              'Forbidden: WalletScoped keys cannot perform admin operations',
            );
          }
          if (apiKey.permission !== Permission.Admin) {
            throw createHttpError(401, 'Unauthorized, admin access required');
          }
        }

        if (
          minPermission == Permission.ReadAndPay &&
          apiKey.permission != Permission.ReadAndPay &&
          apiKey.permission != Permission.Admin &&
          apiKey.permission != Permission.WalletScoped
        ) {
          throw createHttpError(401, 'Unauthorized, payment access required');
        }

        if (
          minPermission == Permission.Read &&
          apiKey.permission != Permission.Read &&
          apiKey.permission != Permission.Admin &&
          apiKey.permission != Permission.ReadAndPay &&
          apiKey.permission != Permission.WalletScoped
        ) {
          throw createHttpError(401, 'Unauthorized, read access required');
        }
        let networkLimit = apiKey.networkLimit;
        let usageLimited = apiKey.usageLimited;
        let allowedWalletIds: string[] = [];

        if (apiKey.permission == Permission.Admin) {
          networkLimit = [Network.Mainnet, Network.Preprod];
          usageLimited = false;
        } else if (apiKey.permission === Permission.WalletScoped) {
          const validWallets = apiKey.ApiKeyHotWallets.filter(
            (ahw) =>
              ahw.HotWallet.deletedAt === null &&
              ahw.HotWallet.PaymentSource.deletedAt === null,
          );

          allowedWalletIds = validWallets.map((ahw) => ahw.HotWallet.id);

          const networks = new Set<Network>();
          for (const ahw of validWallets) {
            networks.add(ahw.HotWallet.PaymentSource.network);
          }
          networkLimit = Array.from(networks);
        }

        return {
          id: apiKey.id,
          permission: apiKey.permission,
          networkLimit: networkLimit,
          usageLimited: usageLimited,
          allowedWalletIds: allowedWalletIds,
        }; // provides endpoints with options.user
      } catch (error) {
        //await a random amount to throttle invalid requests
        logger.info('Throttling invalid requests', { error });
        await new Promise((resolve) =>
          setTimeout(resolve, Math.random() * 1000),
        );
        throw error;
      }
    },
  });

export async function checkIsAllowedNetworkOrThrowUnauthorized(
  networkLimit: Network[],
  network: Network,
  permission: Permission,
) {
  if (permission == Permission.Admin) {
    return;
  }

  if (!networkLimit.includes(network)) {
    //await a random amount to throttle invalid requests
    await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000));
    throw createHttpError(401, 'Unauthorized, network not allowed');
  }
}
