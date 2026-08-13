import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { cursorPaginationArgs } from '@/utils/shared/queries';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { createId } from '@paralleldrive/cuid2';
import createHttpError from 'http-errors';
import { generateApiKeySecureHash } from '@masumi/payment-core/api-key-hash';
import { encrypt, decrypt } from '@/utils/security/encryption';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { transformBigIntAmounts } from '@/utils/shared/transformers';
import { withSerializableSlot } from '@masumi/payment-core/serializable-semaphore';
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
		X402WalletScopes: Array<{ evmWalletId: string }>;
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

/**
 * Resolve wallet-scope ids before they reach createMany. Without this the FK
 * violation surfaces as a raw Prisma error in the 500 body, which both leaks the
 * server's filesystem path and ORM internals and tells the caller nothing
 * actionable. Applies to both rails.
 */
/**
 * Every EVM chain the node has configured, as CAIP-2 ids.
 *
 * The default grant for a new key's ChainIdLimit. NetworkLimit defaults to all
 * Cardano networks, so a key created without an explicit limit reaches the whole
 * Cardano rail; defaulting the EVM half to the empty list made the same key reach
 * no EVM chain at all, which is the opposite default for the same intent. Passing
 * an explicit empty array still grants none.
 */
async function allConfiguredEvmChainIds(): Promise<string[]> {
	const networks = await prisma.x402Network.findMany({
		where: { isEnabled: true },
		select: { caip2Id: true },
	});
	return networks.map((network) => network.caip2Id);
}

/**
 * Reject wallet-scope ids that do not resolve to a live wallet, so a typo fails as
 * a 400 rather than silently creating a scope that grants nothing.
 *
 * Takes the client explicitly: the update path runs inside a Serializable
 * `$transaction`, and using the module-level client there would check on a second
 * connection outside that transaction — so the check could not see the
 * transaction's own writes, could race a concurrent soft-delete, and would hold a
 * second pool connection open for the length of the transaction.
 */
async function assertWalletScopeIdsExist(
	client: Pick<typeof prisma, 'hotWallet' | 'x402EvmWallet'>,
	input: { hotWalletIds?: string[]; evmWalletIds?: string[] },
): Promise<void> {
	if (input.hotWalletIds != null && input.hotWalletIds.length > 0) {
		const ids = Array.from(new Set(input.hotWalletIds));
		const found = await client.hotWallet.findMany({
			where: { id: { in: ids }, deletedAt: null },
			select: { id: true },
		});
		const missing = ids.filter((id) => !found.some((wallet) => wallet.id === id));
		if (missing.length > 0) {
			throw createHttpError(400, `Unknown hot wallet id(s): ${missing.join(', ')}`);
		}
	}
	if (input.evmWalletIds != null && input.evmWalletIds.length > 0) {
		const ids = Array.from(new Set(input.evmWalletIds));
		const found = await client.x402EvmWallet.findMany({
			where: { id: { in: ids }, deletedAt: null },
			select: { id: true },
		});
		const missing = ids.filter((id) => !found.some((wallet) => wallet.id === id));
		if (missing.length > 0) {
			throw createHttpError(400, `Unknown managed EVM wallet id(s): ${missing.join(', ')}`);
		}
	}
}

export const queryAPIKeyEndpointGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: getAPIKeySchemaInput,
	output: getAPIKeySchemaOutput,
	handler: async ({ input }: { input: z.infer<typeof getAPIKeySchemaInput> }) => {
		const result = await prisma.apiKey.findMany({
			// Exclude soft-deleted keys (delete sets deletedAt + status Revoked);
			// otherwise revoked keys stay listed forever and occupy cursor pages.
			where: { deletedAt: null },
			...cursorPaginationArgs(input.cursorId, input.take),
			include: {
				RemainingUsageCredits: { select: { amount: true, unit: true } },
				WalletScopes: { select: { hotWalletId: true } },
				X402WalletScopes: { select: { evmWalletId: true } },
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
		if (isAdmin && input.x402WalletScopeEnabled) {
			throw createHttpError(400, 'Admin API keys cannot have wallet scope enabled');
		}
		// Create runs outside a transaction, so the module-level client is correct here.
		await assertWalletScopeIdsExist(prisma, {
			hotWalletIds: input.walletScopeEnabled ? input.WalletScopeHotWalletIds : undefined,
			evmWalletIds: input.x402WalletScopeEnabled ? input.X402WalletScopeEvmWalletIds : undefined,
		});
		if (isAdmin && input.usageLimited) {
			throw createHttpError(400, 'Admin API keys cannot have usage limits');
		}
		// Omitted means "every configured EVM chain", the twin of NetworkLimit defaulting
		// to every Cardano network. An explicit [] still means none. Skipped for admins,
		// whose networkLimit is [] and who are unrestricted by canAdmin anyway.
		const chainIdLimit = isAdmin ? [] : (input.ChainIdLimit ?? (await allConfiguredEvmChainIds()));
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
				networkLimit: isAdmin
					? []
					: mergeCaip2NetworkLimits(
							input.NetworkLimit,
							// Mirror the update path: ChainIdLimit contributes only EVM (non-Cardano)
							// chains. Cardano access is controlled solely by NetworkLimit, so a
							// Cardano CAIP-2 id passed here is dropped rather than silently granting access.
							chainIdLimit.filter((chainId) => caip2ToCardanoNetwork(chainId) == null),
						),
				walletScopeEnabled: isAdmin ? false : input.walletScopeEnabled,
				x402WalletScopeEnabled: isAdmin ? false : input.x402WalletScopeEnabled,
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
				...(input.x402WalletScopeEnabled && input.X402WalletScopeEvmWalletIds.length > 0
					? {
							X402WalletScopes: {
								createMany: {
									data: input.X402WalletScopeEvmWalletIds.map((evmWalletId) => ({
										evmWalletId,
									})),
								},
							},
						}
					: {}),
			},
			include: {
				RemainingUsageCredits: { select: { amount: true, unit: true } },
				WalletScopes: { select: { hotWalletId: true } },
				X402WalletScopes: { select: { evmWalletId: true } },
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
					const resultingX402WalletScopeEnabled = input.x402WalletScopeEnabled ?? apiKey.x402WalletScopeEnabled;
					if (newCanAdmin && (resultingWalletScopeEnabled || resultingX402WalletScopeEnabled)) {
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

					// `prisma` here is the transaction client (the callback parameter shadows the
					// module-level import), so the existence check shares this Serializable
					// transaction instead of racing it on a second connection.
					await assertWalletScopeIdsExist(prisma, {
						hotWalletIds: input.WalletScopeHotWalletIds,
						evmWalletIds: input.X402WalletScopeEvmWalletIds,
					});

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

					// Same replace-the-whole-list semantic as the Cardano scopes above: an
					// omitted field leaves the existing assignments untouched.
					if (input.X402WalletScopeEvmWalletIds !== undefined) {
						await prisma.apiKeyX402WalletScope.deleteMany({
							where: { apiKeyId: input.id },
						});
						if (input.X402WalletScopeEvmWalletIds.length > 0) {
							await prisma.apiKeyX402WalletScope.createMany({
								data: input.X402WalletScopeEvmWalletIds.map((evmWalletId) => ({
									apiKeyId: input.id,
									evmWalletId,
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
							x402WalletScopeEnabled: newCanAdmin ? false : input.x402WalletScopeEnabled,
							canRead: newCanRead,
							canPay: newCanPay,
							canAdmin: newCanAdmin,
						},
						include: {
							RemainingUsageCredits: { select: { amount: true, unit: true } },
							WalletScopes: { select: { hotWalletId: true } },
							X402WalletScopes: { select: { evmWalletId: true } },
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
				X402WalletScopes: { select: { evmWalletId: true } },
			},
		});
		return mapApiKeyOutput(apiKey);
	},
});
