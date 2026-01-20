import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import { prisma } from '@/utils/db';
import { z } from '@/utils/zod-openapi';
import { Permission, ApiKeyStatus, Network } from '@/generated/prisma/enums';
import { generateSHA256Hash } from '@/utils/crypto';

export type AuthContext = {
  id: string;
  permission: Permission;
  networkLimit: Network[];
  usageLimited: boolean;
};

const authMiddlewareInputSchema = z.object({});

export const authMiddleware = (minPermission: Permission) =>
  new Middleware<
    Record<string, never>,
    AuthContext,
    string,
    typeof authMiddlewareInputSchema
  >({
    security: {
      // this information is optional and used for generating documentation
      type: 'header',
      name: 'api-key',
    },
    input: authMiddlewareInputSchema,
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

        if (
          minPermission == Permission.Admin &&
          apiKey.permission != Permission.Admin
        ) {
          throw createHttpError(401, 'Unauthorized, admin access required');
        }

        if (
          minPermission == Permission.ReadAndPay &&
          apiKey.permission != Permission.ReadAndPay &&
          apiKey.permission != Permission.Admin
        ) {
          throw createHttpError(401, 'Unauthorized, payment access required');
        }

        if (
          minPermission == Permission.Read &&
          apiKey.permission != Permission.Read &&
          apiKey.permission != Permission.Admin &&
          apiKey.permission != Permission.ReadAndPay
        ) {
          throw createHttpError(401, 'Unauthorized, read access required');
        }
        let networkLimit = apiKey.networkLimit;
        if (apiKey.permission == Permission.Admin) {
          networkLimit = [Network.Mainnet, Network.Preprod];
        }
        let usageLimited = apiKey.usageLimited;
        if (apiKey.permission == Permission.Admin) {
          usageLimited = false;
        }

        return {
          id: apiKey.id,
          permission: apiKey.permission,
          networkLimit: networkLimit,
          usageLimited: usageLimited,
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
