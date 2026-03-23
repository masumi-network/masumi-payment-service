import { ApiKeyStatus, Network } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { apiKeyOutputSchema } from './schemas';

export const apiKeyExample = {
	id: 'api_key_id',
	token: 'masumi_payment_api_key_secret',
	permission: 'Admin' as const,
	canRead: true,
	canPay: true,
	canAdmin: true,
	usageLimited: true,
	NetworkLimit: [Network.Preprod],
	RemainingUsageCredits: [
		{
			unit: '',
			amount: '10000000',
		},
	],
	status: ApiKeyStatus.Active,
	walletScopeEnabled: false,
	WalletScopes: [],
} satisfies z.infer<typeof apiKeyOutputSchema>;

export const listAPIKeysQueryExample = {
	take: 10,
	cursorToken: 'identifier',
};

export const addAPIKeyBodyExample = {
	usageLimited: 'true',
	UsageCredits: [
		{
			unit: '',
			amount: '10000000',
		},
	],
	canAdmin: true,
	walletScopeEnabled: 'false',
	WalletScopeHotWalletIds: [],
};

export const updateAPIKeyBodyExample = {
	id: 'unique_cuid_v2_of_entry_to_update',
	token: 'api_key_to_change_to',
	UsageCreditsToAddOrRemove: [
		{
			unit: '',
			amount: '10000000',
		},
		{
			unit: 'c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad0014df105553444d',
			amount: '-25000000',
		},
	],
	status: ApiKeyStatus.Active,
	walletScopeEnabled: false,
	WalletScopeHotWalletIds: ['hot_wallet_id_1', 'hot_wallet_id_2'],
};

export const updateAPIKeyResponseExample = {
	...apiKeyExample,
	NetworkLimit: [Network.Preprod, Network.Mainnet],
};

export const deleteAPIKeyBodyExample = {
	id: 'id_or_apiKey_unique_cuid_v2_of_entry_to_delete',
};

export const deleteAPIKeyResponseExample = {
	...apiKeyExample,
	status: ApiKeyStatus.Revoked,
};
