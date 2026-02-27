import { Middleware } from 'express-zod-api';
import createHttpError from 'http-errors';
import { prisma } from '@/utils/db';
import { z } from '@/utils/zod-openapi';
import { ApiKeyStatus, Network } from '@/generated/prisma/enums';
import { generateSHA256Hash } from '@/utils/crypto';
import { RequiredPermission, hasPermission, getPermissionName } from '@/utils/permissions';

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
	/** Networks this API key is allowed to access (ignored if canAdmin=true) */
	networkLimit: Network[];
	/** Whether this API key has usage credit limits (ignored if canAdmin=true) */
	usageLimited: boolean;
};

const authMiddlewareInputSchema = z.object({});

/**
 * Authentication middleware factory.
 * Creates middleware that validates API key and checks permission level.
 *
 * @param minPermission - Minimum permission level required for the endpoint
 * @returns Express-zod-api middleware
 */
export const authMiddleware = (minPermission: RequiredPermission) =>
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
						tokenHash: generateSHA256Hash(sentKey),
					},
				});

				if (!apiKey) {
					throw createHttpError(401, 'Unauthorized, invalid authentication token provided');
				}

				if (apiKey.status !== ApiKeyStatus.Active) {
					throw createHttpError(401, 'Unauthorized, API key is revoked');
				}

				// Check if user has required permission using flag-based system
				if (!hasPermission(minPermission, apiKey.canRead, apiKey.canPay, apiKey.canAdmin)) {
					const permissionName = getPermissionName(minPermission);
					throw createHttpError(401, `Unauthorized, ${permissionName} access required`);
				}

				// Admin special handling: bypass network and usage limits
				let networkLimit = apiKey.networkLimit;
				let usageLimited = apiKey.usageLimited;

				if (apiKey.canAdmin) {
					networkLimit = [Network.Mainnet, Network.Preprod];
					usageLimited = false;
				}

				return {
					id: apiKey.id,
					canRead: apiKey.canRead,
					canPay: apiKey.canPay,
					canAdmin: apiKey.canAdmin,
					networkLimit: networkLimit,
					usageLimited: usageLimited,
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
 * Admin users bypass this check.
 *
 * @param networkLimit - Networks the user is allowed to access
 * @param network - The network being accessed
 * @param canAdmin - Whether the user has admin access
 * @throws 401 Unauthorized if network is not allowed
 */
export async function checkIsAllowedNetworkOrThrowUnauthorized(
	networkLimit: Network[],
	network: Network,
	canAdmin: boolean,
) {
	// Admin bypasses network restrictions
	if (canAdmin) {
		return;
	}

	if (!networkLimit.includes(network)) {
		//await a random amount to throttle invalid requests
		await new Promise((resolve) => setTimeout(resolve, Math.random() * 1000));
		throw createHttpError(401, 'Unauthorized, network not allowed');
	}
}
