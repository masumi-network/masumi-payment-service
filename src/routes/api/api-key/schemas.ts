import { z } from '@/utils/zod-openapi';
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
		status: z.nativeEnum(ApiKeyStatus).describe('Current status of the API key'),
		walletScopeEnabled: z.boolean().describe('Whether wallet scope filtering is enabled for this API key'),
		WalletScopes: z
			.array(
				z.object({
					hotWalletId: z.string().describe('ID of the hot wallet in scope'),
				}),
			)
			.describe('List of hot wallets this API key is scoped to'),
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
						'Asset policy id + asset name concatenated. Use an empty string for ADA/lovelace e.g (1000000 lovelace = 1 ADA)',
					),
				amount: z
					.string()
					.describe(
						'The quantity of the asset. Make sure to convert it from the underlying smallest unit (in case of decimals, multiply it by the decimal factor e.g. for 1 ADA = 10000000 lovelace)',
					),
			}),
		)
		.describe('The credits allowed to be used by the API key. Only relevant if usageLimited is true. '),
	NetworkLimit: z
		.array(z.nativeEnum(Network))
		.max(3)
		.default([Network.Mainnet, Network.Preprod])
		.describe('The networks the API key is allowed to use'),
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
	walletScopeEnabled: z
		.string()
		.default('false')
		.transform((s) => s.toLowerCase() == 'true')
		.describe('Whether to enable wallet scope filtering for this API key'),
	WalletScopeHotWalletIds: z
		.array(z.string().max(150))
		.max(100)
		.default([])
		.describe('List of hot wallet IDs to scope this API key to'),
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
		.describe('The amount of credits to add or remove from the API key. Only relevant if usageLimited is true. '),
	usageLimited: z.boolean().default(true).optional().describe('Whether the API key is usage limited'),
	status: z.nativeEnum(ApiKeyStatus).default(ApiKeyStatus.Active).optional().describe('The status of the API key'),
	NetworkLimit: z
		.array(z.nativeEnum(Network))
		.max(3)
		.default([Network.Mainnet, Network.Preprod])
		.optional()
		.describe('The networks the API key is allowed to use'),
	walletScopeEnabled: z.boolean().optional().describe('Whether to enable wallet scope filtering for this API key'),
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
