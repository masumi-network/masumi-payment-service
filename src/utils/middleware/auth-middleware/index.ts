import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import { prisma } from '@/utils/db';
import { z } from '@/utils/zod-openapi';
import { ApiKeyStatus, Network } from '@/generated/prisma/enums';
import { generateApiKeySecureHash } from '@/utils/crypto';
import { RequiredPermissionFlags, hasPermission, getPermissionName } from '@/utils/permissions';

/**
 * Authentication context passed to endpoint handlers.
 * Contains the authenticated user's permissions and limits.
 */
export type AuthContext = {
	/** Unique identifier of the API key */
	id: string;
	/** Whether the user can access read endpoints */
	canRead: boolean;
	/** Whether the user can access pay/purchase endpoints */
	canPay: boolean;
	/** Whether the user has admin access (bypasses network/usage limits) */
	canAdmin: boolean;
	/** Networks this API key is allowed to access (already set to all networks if canAdmin=true) */
	networkLimit: Network[];
	/** Whether this API key has usage credit limits (already false if canAdmin=true) */
	usageLimited: boolean;
	walletScopeIds: string[] | null;
};

const authMiddlewareInputSchema = z.object({});

/**
 * Authentication middleware factory.
 * Creates middleware that validates API key and checks required permission flags.
 *
 * @param required - Permission flags that must be satisfied (e.g. { canRead: true })
 * @returns Express-zod-api middleware
 */
export const authMiddleware = (required: RequiredPermissionFlags) =>
	new Middleware<Record<string, never>, AuthContext, string, typeof authMiddlewareInputSchema>({
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
					throw createHttpError(401, 'Unauthorized, no authentication token provided');
				}

				const apiKey = await prisma.apiKey.findUnique({
					where: {
						tokenHashSecure: await generateApiKeySecureHash(sentKey),
					},
					include: {
						WalletScopes: { select: { hotWalletId: true } },
					},
				});

				if (!apiKey) {
					throw createHttpError(401, 'Unauthorized, invalid authentication token provided');
				}

				if (apiKey.status !== ApiKeyStatus.Active) {
					throw createHttpError(401, 'Unauthorized, API key is revoked');
				}

				// Check if user has required permission flags
				if (!hasPermission(required, apiKey.canRead, apiKey.canPay, apiKey.canAdmin)) {
					const permissionName = getPermissionName(required);
					throw createHttpError(401, `Unauthorized, ${permissionName} access required`);
				}

				// Admin special handling: bypass network and usage limits
				let networkLimit = apiKey.networkLimit;
				let usageLimited = apiKey.usageLimited;

				if (apiKey.canAdmin) {
					networkLimit = [Network.Mainnet, Network.Preprod];
					usageLimited = false;
				}

				const walletScopeIds =
					apiKey.canAdmin || !apiKey.walletScopeEnabled ? null : apiKey.WalletScopes.map((ws) => ws.hotWalletId);

				return {
					id: apiKey.id,
					canRead: apiKey.canRead,
					canPay: apiKey.canPay,
					canAdmin: apiKey.canAdmin,
					networkLimit: networkLimit,
					usageLimited: usageLimited,
					walletScopeIds: walletScopeIds,
				}; // provides endpoints with options.user
			} catch (error) {
				//await a random amount to throttle invalid requests
				logger.info('Throttling invalid requests', { error });
				await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000));
				throw error;
			}
		},
	});

/**
 * Checks if the user is allowed to access the specified network.
 * Note: admin users already have all networks set in their networkLimit by the auth middleware,
 * so no explicit admin check is needed here.
 *
 * @param networkLimit - Networks the user is allowed to access
 * @param network - The network being accessed
 * @throws 401 Unauthorized if network is not allowed
 */
export async function checkIsAllowedNetworkOrThrowUnauthorized(networkLimit: Network[], network: Network) {
	if (!networkLimit.includes(network)) {
		//await a random amount to throttle invalid requests
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000));
		throw createHttpError(401, 'Unauthorized, network not allowed');
	}
}
