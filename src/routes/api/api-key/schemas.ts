import { z } from '@masumi/payment-core/zod';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

export const getAPIKeySchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(10).describe('The number of API keys to return'),
	cursorId: z
		.string()
		.max(550)
		.optional()
		.describe('Used to paginate through the API keys (provide the id of the last returned key)'),
});

export const apiKeyOutputSchema = z
	.object({
		id: z.string().describe('Unique identifier for the API key'),
		token: z.string().describe('The API key token'),
		permission: z
			.enum(['Read', 'ReadAndPay', 'Admin'])
			.describe('Permission level of the API key DEPRECATED (computed from flags for backward compatibility)'),
		canRead: z.boolean().describe('Whether this API key can access read endpoints'),
		canPay: z.boolean().describe('Whether this API key can access payment/purchase endpoints'),
		canAdmin: z.boolean().describe('Whether this API key has admin access'),
		usageLimited: z.boolean().describe('Whether the API key has usage limits'),
		NetworkLimit: z.array(z.nativeEnum(Network)).describe('List of Cardano networks this API key is allowed to access'),
		ChainIdLimit: z
			.array(z.string().min(1).max(120))
			.describe('CAIP-2 chain identifiers this API key is allowed to access'),
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
							'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 1000000 lovelace)',
						),
				}),
			)
			.describe('Remaining usage credits for this API key'),
		status: z.nativeEnum(ApiKeyStatus).describe('Current status of the API key'),
		walletScopeEnabled: z.boolean().describe('Whether wallet scope filtering is enabled for this API key'),
		WalletScopes: z
			.array(
				z.object({
					hotWalletId: z.string().describe('ID of the hot wallet in scope'),
				}),
			)
			.describe('List of hot wallets this API key is scoped to'),
		x402WalletScopeEnabled: z
			.boolean()
			.describe('Whether managed EVM wallet scope filtering is enabled for this API key'),
		X402WalletScopes: z
			.array(
				z.object({
					evmWalletId: z.string().describe('ID of the managed EVM wallet in scope'),
				}),
			)
			.describe(
				'Managed EVM wallets this API key is scoped to. The key additionally always reaches wallets it created itself.',
			),
	})
	.openapi('APIKey');

export const getAPIKeySchemaOutput = z.object({
	ApiKeys: z.array(apiKeyOutputSchema).describe('List of API keys'),
});

export const addAPIKeySchemaInput = z.object({
	usageLimited: z
		.string()
		.default('true')
		.transform((s) => (s.toLowerCase() == 'true' ? true : false))
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
						'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA); ' +
							'"lovelace" is accepted and stored as the empty string. ' +
							'For x402/EVM spending the unit is chain-qualified as "<caip2Network>:<assetAddress>" (lowercased), ' +
							'e.g. "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913". Gas-token units are not supported.',
					),
				amount: z
					.string()
					.describe(
						'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 1000000 lovelace)',
					),
			}),
		)
		.describe('The credits allowed to be used by the API key. Only relevant if usageLimited is true. '),
	NetworkLimit: z
		.array(z.nativeEnum(Network))
		.max(3)
		.default([Network.Mainnet, Network.Preprod])
		.describe('The Cardano networks the API key is allowed to use'),
	ChainIdLimit: z
		.array(
			z
				.string()
				.regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, 'Each entry must be a CAIP-2 chain id like eip155:8453')
				.refine(
					(chainId) => !chainId.toLowerCase().startsWith('cardano:'),
					'Use NetworkLimit for Cardano networks; ChainIdLimit is for non-Cardano CAIP-2 chain ids',
				),
		)
		.max(50)
		.optional()
		.describe(
			'Additional non-Cardano CAIP-2 chain identifiers the API key is allowed to use. Omit to grant every ' +
				'configured EVM chain, mirroring NetworkLimit defaulting to all Cardano networks; pass an empty ' +
				'array to grant none.',
		),
	/** @deprecated Use canRead, canPay, canAdmin flags instead. Will be removed in a future version. */
	permission: z
		.enum(['Read', 'ReadAndPay', 'Admin'])
		.default('Read')
		.describe(
			'[DEPRECATED] The permission of the API key. Use canRead/canPay/canAdmin flags instead. Will be removed in a future version.',
		),
	// Flag-based permissions (new system - preferred)
	canRead: z.boolean().optional().describe('Whether this API key can access read endpoints'),
	canPay: z.boolean().optional().describe('Whether this API key can access payment/purchase endpoints'),
	canAdmin: z.boolean().optional().describe('Whether this API key has admin access'),
	// Boolean, or the exact strings 'true'/'false' for backward compatibility with
	// clients that sent the old string form. Anything else — 'yes', '1', 'True ' —
	// is a 400. The old bare-string truthiness transform silently parsed all of
	// those to FALSE, creating the key UNSCOPED (unrestricted) while the caller
	// believed it was scoped; and it rejected the JSON boolean that the update
	// endpoint accepts for the same field.
	walletScopeEnabled: z
		.union([z.boolean(), z.enum(['true', 'false'])])
		.default(false)
		.transform((value) => value === true || value === 'true')
		.describe('Whether to enable wallet scope filtering for this API key'),
	WalletScopeHotWalletIds: z
		.array(z.string().max(150))
		.max(100)
		.default([])
		.describe('List of hot wallet IDs to scope this API key to'),
	x402WalletScopeEnabled: z
		.union([z.boolean(), z.enum(['true', 'false'])])
		.default(false)
		.transform((value) => value === true || value === 'true')
		.describe(
			'Whether to enable managed EVM wallet scope filtering. False leaves the key unrestricted, matching walletScopeEnabled.',
		),
	X402WalletScopeEvmWalletIds: z
		.array(z.string().max(150))
		.max(100)
		.default([])
		.describe(
			'Managed EVM wallet IDs to scope this API key to. Only applied when x402WalletScopeEnabled is true; the key also always reaches wallets it created itself.',
		),
});

export const addAPIKeySchemaOutput = apiKeyOutputSchema;

export const updateAPIKeySchemaInput = z.object({
	id: z.string().max(150).describe('The id of the API key to update. Provide either id or apiKey'),
	token: z.string().min(15).max(550).optional().describe('To change the api key token'),
	UsageCreditsToAddOrRemove: z
		.array(
			z.object({
				unit: z
					.string()
					.max(150)
					.describe(
						'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA); ' +
							'"lovelace" is accepted and stored as the empty string. ' +
							'For x402/EVM spending the unit is chain-qualified as "<caip2Network>:<assetAddress>" (lowercased), ' +
							'e.g. "eip155:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913". Gas-token units are not supported.',
					),
				amount: z
					.string()
					.describe(
						'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 1000000 lovelace)',
					),
			}),
		)
		.max(25)
		.optional()
		.describe('The amount of credits to add or remove from the API key. Only relevant if usageLimited is true. '),
	// No `.default(...)` on a PATCH field. Zod applies a default when the key is
	// ABSENT, so `.default(true).optional()` turned every partial update that did
	// not mention usageLimited into "cap this key", and the update dialog never
	// sends the field. A key with no RemainingUsageCredits rows then failed every
	// purchase with `Credit unit not found`, which surfaces as a bare 400
	// 'Insufficient funds'. The same shape on `status` silently re-activated a
	// Revoked key on any unrelated edit, and the defaulted `true` made the admin
	// guard below reject the plain promotion call PATCH {id, canAdmin: true}.
	// Omitted must mean unchanged, like every other field on this schema.
	usageLimited: z.boolean().optional().describe('Whether the API key is usage limited. Omit to leave it unchanged.'),
	status: z.nativeEnum(ApiKeyStatus).optional().describe('The status of the API key. Omit to leave it unchanged.'),
	NetworkLimit: z
		.array(z.nativeEnum(Network))
		.max(3)
		.optional()
		.describe('Replaces the Cardano-network half of the access list. Omit to leave Cardano access unchanged.'),
	ChainIdLimit: z
		.array(
			z
				.string()
				.regex(/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/, 'Each entry must be a CAIP-2 chain id like eip155:8453')
				.refine(
					(chainId) => !chainId.toLowerCase().startsWith('cardano:'),
					'Use NetworkLimit for Cardano networks; ChainIdLimit is for non-Cardano CAIP-2 chain ids',
				),
		)
		.max(50)
		.optional()
		.describe('Replaces the EVM (CAIP-2) half of the access list. Omit to leave EVM access unchanged.'),
	walletScopeEnabled: z.boolean().optional().describe('Whether to enable wallet scope filtering for this API key'),
	x402WalletScopeEnabled: z
		.boolean()
		.optional()
		.describe('Whether to enable managed EVM wallet scope filtering for this API key'),
	X402WalletScopeEvmWalletIds: z
		.array(z.string().max(150))
		.max(100)
		.optional()
		.describe('Replaces the managed EVM wallets this API key is scoped to'),
	WalletScopeHotWalletIds: z
		.array(z.string().max(150))
		.max(100)
		.optional()
		.describe('List of hot wallet IDs to scope this API key to. Replaces existing scopes when provided'),
	// Flag-based permissions (optional for updates)
	canRead: z.boolean().optional().describe('Whether this API key can access read endpoints'),
	canPay: z.boolean().optional().describe('Whether this API key can access payment/purchase endpoints'),
	canAdmin: z.boolean().optional().describe('Whether this API key has admin access'),
});

export const updateAPIKeySchemaOutput = apiKeyOutputSchema;

export const deleteAPIKeySchemaInput = z.object({
	id: z.string().max(150).describe('The id of the API key to be (soft) deleted.'),
});

export const deleteAPIKeySchemaOutput = apiKeyOutputSchema;
