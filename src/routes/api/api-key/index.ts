import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';
import { generateApiKeySecureHash } from '@masumi/payment-core/api-key-hash';
import { encrypt, decrypt } from '@/utils/security/encryption';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { transformBigIntAmounts } from '@/utils/shared/transformers';
import { withSerializableSlot } from '@/utils/db/serializable-semaphore';
import { z } from '@masumi/payment-core/zod';
import {
	caip2LimitToCardanoNetworks,
	caip2ToCardanoNetwork,
	cardanoNetworksToCaip2,
	mergeCaip2NetworkLimits,
} from '@masumi/payment-core/network';
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
import {
	computePermissionFromFlags,
	flagsFromLegacyPermission,
	LegacyPermission,
} from '@masumi/payment-core/permissions';

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

/**
 * Serialize an ApiKey row to the API response shape.
 *
 * `options.revealToken` controls whether the response contains the
 * decrypted plaintext token (`true`) or the pre-masked `*****xxxx`
 * form (`false`, default). The reveal path is only safe for endpoints
 * where the admin is creating a new key and MUST see the value once
 * (it cannot be recovered later by design — the DB only stores the
 * encrypted form). List/update/delete responses MUST mask, so an
 * admin-token leak does not cascade into a full plaintext dump of
 * every API key on the system, and so monitoring/log aggregation
 * never captures plaintext via response logging.
 */
export const mapApiKeyOutput = <
	T extends {
		canRead: boolean;
		canPay: boolean;
		canAdmin: boolean;
		usageLimited: boolean;
		networkLimit: string[];
		RemainingUsageCredits: Array<{ amount: bigint; unit: string }>;
		WalletScopes: Array<{ hotWalletId: string }>;
		encryptedToken: string | null;
		token: string | null;
		tokenHash: string | null;
	},
>(
	data: T,
	options: { revealToken?: boolean } = {},
) => {
	// Explicitly destructure all sensitive/internal fields so they never reach the API response
	const {
		networkLimit,
		usageLimited,
		RemainingUsageCredits,
		encryptedToken,
		token: storedMaskedToken,
		tokenHash: _tokenHash,
		...rest
	} = data;
	return {
		...rest,
		// Response schema expects `string`. Coalesce null (legacy row missing
		// the stored masked form, or decrypt failure) to '*****' so the
		// non-null contract holds. Real rows always populate `token` at
		// create time (see addAPIKeyEndpointPost above).
		token: (options.revealToken === true ? decryptTokenSafe(encryptedToken) : storedMaskedToken) ?? '*****',
		permission: computePermissionFromFlags(data.canRead, data.canPay, data.canAdmin),
		usageLimited: data.canAdmin ? false : usageLimited,
		NetworkLimit: data.canAdmin ? [Network.Mainnet, Network.Preprod] : caip2LimitToCardanoNetworks(networkLimit),
		ChainIdLimit: data.canAdmin ? [] : networkLimit,
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
				networkLimit: isAdmin ? [] : mergeCaip2NetworkLimits(input.NetworkLimit, input.ChainIdLimit),
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
		// Reveal-on-create: the admin must see the freshly-minted token once
		// because the DB only stores the encrypted form afterwards. List,
		// update, and delete endpoints below default to the masked form.
		return mapApiKeyOutput(result, { revealToken: true });
	},
});

export const updateAPIKeyEndpointPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: updateAPIKeySchemaInput,
	output: updateAPIKeySchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof updateAPIKeySchemaInput> }) => {
		// Compute encryption and hash outside the transaction (async PBKDF2 must not block the transaction)
		const newEncryptedToken = input.token !== undefined ? encrypt(input.token) : undefined;
		const newTokenHash = input.token !== undefined ? await generateApiKeySecureHash(input.token) : undefined;
		const newMaskedToken = input.token !== undefined ? '*****' + input.token.slice(-4) : undefined;

		// Gate Serializable $transaction through the shared semaphore so
		// concurrent HTTP requests don't exhaust the pg connection pool.
		// See `src/utils/db/serializable-semaphore.ts`.
		const apiKey = await withSerializableSlot(() =>
			prisma.$transaction(
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
					// Update each half of the access list independently: NetworkLimit replaces
					// only the Cardano-network entries, ChainIdLimit replaces only the EVM
					// entries. An omitted field leaves its half untouched (no silent reset).
					const nextNetworkLimit = newCanAdmin
						? []
						: input.NetworkLimit === undefined && input.ChainIdLimit === undefined
							? undefined
							: Array.from(
									new Set([
										...(input.NetworkLimit !== undefined
											? cardanoNetworksToCaip2(input.NetworkLimit)
											: apiKey.networkLimit.filter((chainId) => caip2ToCardanoNetwork(chainId) != null)),
										...(input.ChainIdLimit !== undefined
											? input.ChainIdLimit.filter((chainId) => caip2ToCardanoNetwork(chainId) == null)
											: apiKey.networkLimit.filter((chainId) => caip2ToCardanoNetwork(chainId) == null)),
									]),
								);

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
										tokenHash: newTokenHash,
										token: newMaskedToken,
									}
								: {}),
							usageLimited: newCanAdmin ? false : input.usageLimited,
							status: input.status,
							networkLimit: nextNetworkLimit,
							walletScopeEnabled: newCanAdmin ? false : input.walletScopeEnabled,
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
			),
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
