import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';
import { generateApiKeySecureHash } from '@/utils/crypto/api-key-hash';
import { encrypt, decrypt } from '@/utils/security/encryption';
import { CONSTANTS } from '@/utils/config';
import { logger } from '@/utils/logger';
import { transformBigIntAmounts } from '@/utils/shared/transformers';
import { z } from '@/utils/zod-openapi';
import {
	addAPIKeySchemaInput,
	addAPIKeySchemaOutput,
	apiKeyOutputSchema,
	deleteAPIKeySchemaInput,
	deleteAPIKeySchemaOutput,
	getAPIKeySchemaInput,
	getAPIKeySchemaOutput,
	updateAPIKeySchemaInput,
	updateAPIKeySchemaOutput,
} from './schemas';
import { computePermissionFromFlags, flagsFromLegacyPermission, LegacyPermission } from '@/utils/permissions';

export {
	addAPIKeySchemaInput,
	addAPIKeySchemaOutput,
	apiKeyOutputSchema,
	deleteAPIKeySchemaInput,
	deleteAPIKeySchemaOutput,
	getAPIKeySchemaInput,
	getAPIKeySchemaOutput,
	updateAPIKeySchemaInput,
	updateAPIKeySchemaOutput,
};

const decryptTokenSafe = (encryptedToken: string | null): string => {
	if (!encryptedToken) return '';
	try {
		return decrypt(encryptedToken);
	} catch (e) {
		logger.error('Failed to decrypt API key token — encryptedToken may be corrupted or ENCRYPTION_KEY changed', {
			error: e,
		});
		return '';
	}
};

export const mapApiKeyOutput = <
	T extends {
		canRead: boolean;
		canPay: boolean;
		canAdmin: boolean;
		networkLimit: Network[];
		RemainingUsageCredits: Array<{ amount: bigint; unit: string }>;
		WalletScopes: Array<{ hotWalletId: string }>;
		encryptedToken: string | null;
		token: string | null;
		tokenHash: string | null;
	},
>(
	data: T,
) => {
	// Explicitly destructure all sensitive/internal fields so they never reach the API response
	const { networkLimit, RemainingUsageCredits, encryptedToken, token: _token, tokenHash: _tokenHash, ...rest } = data;
	return {
		...rest,
		token: decryptTokenSafe(encryptedToken),
		permission: computePermissionFromFlags(data.canRead, data.canPay, data.canAdmin),
		NetworkLimit: networkLimit,
		RemainingUsageCredits: transformBigIntAmounts(RemainingUsageCredits),
	};
};

export const queryAPIKeyEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getAPIKeySchemaInput,
	output: getAPIKeySchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof getAPIKeySchemaInput> }) => {
		const result = await prisma.apiKey.findMany({
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
			take: input.take,
			include: {
				RemainingUsageCredits: { select: { amount: true, unit: true } },
				WalletScopes: { select: { hotWalletId: true } },
			},
		});
		return {
			ApiKeys: result.map((data) => mapApiKeyOutput(data)),
		};
	},
});

export const addAPIKeyEndpointPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: addAPIKeySchemaInput,
	output: addAPIKeySchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof addAPIKeySchemaInput> }) => {
		// Determine flags: prefer explicit flags, fall back to legacy permission
		let canRead: boolean;
		let canPay: boolean;
		let canAdmin: boolean;

		if (input.canRead !== undefined || input.canPay !== undefined || input.canAdmin !== undefined) {
			// New flag-based input - use flags directly
			canRead = input.canRead ?? true;
			canPay = input.canPay ?? false;
			canAdmin = input.canAdmin ?? false;
		} else if (input.permission) {
			// Legacy permission input - convert to flags
			const flags = flagsFromLegacyPermission(input.permission as LegacyPermission);
			canRead = flags.canRead;
			canPay = flags.canPay;
			canAdmin = flags.canAdmin;
		} else {
			// Default: read-only
			canRead = true;
			canPay = false;
			canAdmin = false;
		}

		const isAdmin = canAdmin;
		if (isAdmin && input.walletScopeEnabled) {
			throw createHttpError(400, 'Admin API keys cannot have wallet scope enabled');
		}
		if (isAdmin && input.usageLimited) {
			throw createHttpError(400, 'Admin API keys cannot have usage limits');
		}
		const apiKey = 'masumi-payment-' + (isAdmin ? 'admin-' : '') + createId();
		const result = await prisma.apiKey.create({
			data: {
				encryptedToken: encrypt(apiKey),
				tokenHash: await generateApiKeySecureHash(apiKey),
				token: '*****' + apiKey.slice(-4),
				status: ApiKeyStatus.Active,
				canRead: canRead,
				canPay: canPay,
				canAdmin: canAdmin,
				usageLimited: isAdmin ? false : input.usageLimited,
				networkLimit: isAdmin ? [Network.Mainnet, Network.Preprod] : input.NetworkLimit,
				walletScopeEnabled: isAdmin ? false : input.walletScopeEnabled,
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
				...(input.walletScopeEnabled && input.WalletScopeHotWalletIds.length > 0
					? {
							WalletScopes: {
								createMany: {
									data: input.WalletScopeHotWalletIds.map((hotWalletId) => ({
										hotWalletId,
									})),
								},
							},
						}
					: {}),
			},
			include: {
				RemainingUsageCredits: { select: { amount: true, unit: true } },
				WalletScopes: { select: { hotWalletId: true } },
			},
		});
		return mapApiKeyOutput(result);
	},
});

export const updateAPIKeyEndpointPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: updateAPIKeySchemaInput,
	output: updateAPIKeySchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof updateAPIKeySchemaInput> }) => {
		// Compute encryption and hash outside the transaction (async PBKDF2 must not block the transaction)
		const newEncryptedToken = input.token !== undefined ? encrypt(input.token) : undefined;
		const newTokenHashSecure = input.token !== undefined ? await generateApiKeySecureHash(input.token) : undefined;

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
						const existingCredit = apiKey.RemainingUsageCredits.find((credit) => credit.unit == usageCredit.unit);
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

				// Determine new flag values
				const newCanRead = input.canRead !== undefined ? input.canRead : apiKey.canRead;
				const newCanPay = input.canPay !== undefined ? input.canPay : apiKey.canPay;
				const newCanAdmin = input.canAdmin !== undefined ? input.canAdmin : apiKey.canAdmin;

				const resultingWalletScopeEnabled = input.walletScopeEnabled ?? apiKey.walletScopeEnabled;
				if (newCanAdmin && resultingWalletScopeEnabled) {
					throw createHttpError(400, 'Admin API keys cannot have wallet scope enabled');
				}
				if (newCanAdmin && input.usageLimited) {
					throw createHttpError(400, 'Admin API keys cannot have usage limits');
				}

				if (input.WalletScopeHotWalletIds !== undefined) {
					await prisma.apiKeyWalletScope.deleteMany({
						where: { apiKeyId: input.id },
					});
					if (input.WalletScopeHotWalletIds.length > 0) {
						await prisma.apiKeyWalletScope.createMany({
							data: input.WalletScopeHotWalletIds.map((hotWalletId) => ({
								apiKeyId: input.id,
								hotWalletId,
							})),
						});
					}
				}

				const result = await prisma.apiKey.update({
					where: { id: input.id },
					data: {
						...(input.token !== undefined
							? {
									encryptedToken: newEncryptedToken,
									tokenHashSecure: newTokenHashSecure,
									token: null,
									tokenHash: null,
								}
							: {}),
						usageLimited: input.usageLimited,
						status: input.status,
						networkLimit: input.NetworkLimit,
						walletScopeEnabled: input.walletScopeEnabled,
						canRead: newCanRead,
						canPay: newCanPay,
						canAdmin: newCanAdmin,
					},
					include: {
						RemainingUsageCredits: { select: { amount: true, unit: true } },
						WalletScopes: { select: { hotWalletId: true } },
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
		return mapApiKeyOutput(apiKey);
	},
});

export const deleteAPIKeyEndpointDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteAPIKeySchemaInput,
	output: deleteAPIKeySchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof deleteAPIKeySchemaInput> }) => {
		const apiKey = await prisma.apiKey.update({
			where: { id: input.id },
			data: { deletedAt: new Date(), status: ApiKeyStatus.Revoked },
			include: {
				RemainingUsageCredits: { select: { amount: true, unit: true } },
				WalletScopes: { select: { hotWalletId: true } },
			},
		});
		return mapApiKeyOutput(apiKey);
	},
});
