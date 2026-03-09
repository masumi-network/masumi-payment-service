import { adminAuthenticatedEndpointFactory } from '@/utils/security/auth/admin-authenticated';
import { ApiKeyStatus, Network, Permission } from '@/generated/prisma/client';
import { prisma } from '@/utils/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';
import { generateSHA256Hash } from '@/utils/crypto';
import { CONSTANTS } from '@/utils/config';
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

export const mapApiKeyOutput = <
	T extends {
		networkLimit: Network[];
		RemainingUsageCredits: Array<{ amount: bigint; unit: string }>;
		WalletScopes: Array<{ hotWalletId: string }>;
	},
>(
	data: T,
) => {
	const { networkLimit, RemainingUsageCredits, ...rest } = data;
	return {
		...rest,
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
			cursor: input.cursorToken ? { token: input.cursorToken } : undefined,
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
		const isAdmin = input.permission == Permission.Admin;
		if (isAdmin && input.walletScopeEnabled) {
			throw createHttpError(400, 'Admin API keys cannot have wallet scope enabled');
		}
		if (isAdmin && input.usageLimited) {
			throw createHttpError(400, 'Admin API keys cannot have usage limits');
		}
		const apiKey = 'masumi-payment-' + (isAdmin ? 'admin-' : '') + createId();
		const result = await prisma.apiKey.create({
			data: {
				token: apiKey,
				tokenHash: generateSHA256Hash(apiKey),
				status: ApiKeyStatus.Active,
				permission: input.permission,
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
				const resultingWalletScopeEnabled = input.walletScopeEnabled ?? apiKey.walletScopeEnabled;
				const resultingPermission = apiKey.permission;
				if (resultingPermission === Permission.Admin && resultingWalletScopeEnabled) {
					throw createHttpError(400, 'Admin API keys cannot have wallet scope enabled');
				}
				if (resultingPermission === Permission.Admin && input.usageLimited) {
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
						token: input.token,
						tokenHash: input.token ? generateSHA256Hash(input.token) : undefined,
						usageLimited: input.usageLimited,
						status: input.status,
						networkLimit: input.NetworkLimit,
						walletScopeEnabled: input.walletScopeEnabled,
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
