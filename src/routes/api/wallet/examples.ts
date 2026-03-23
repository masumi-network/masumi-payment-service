import { Network } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { getWalletSchemaOutput, postWalletSchemaOutput } from './schemas';

export const walletExample = {
	walletVkey: 'wallet_vkey',
	note: 'note',
	PendingTransaction: null,
	walletAddress: 'wallet_address',
	collectionAddress: 'collection_address',
	LowBalanceSummary: {
		isLow: true,
		lowRuleCount: 1,
		lastCheckedAt: new Date(1713636260),
	},
	LowBalanceRules: [
		{
			id: 'low_balance_rule_id',
			assetUnit: 'lovelace',
			thresholdAmount: '5000000',
			enabled: true,
			status: 'Low',
			lastKnownAmount: '4200000',
			lastCheckedAt: new Date(1713636260),
			lastAlertedAt: new Date(1713636260),
		},
	],
	Secret: undefined,
} satisfies z.infer<typeof getWalletSchemaOutput>;

export const getWalletQueryExample = {
	id: 'unique_cuid_v2_of_entry_to_delete',
	includeSecret: 'true',
	walletType: 'Selling',
};

export const createWalletBodyExample = {
	network: Network.Preprod,
};

export const createWalletResponseExample = {
	walletMnemonic: 'wallet_mnemonic',
	walletAddress: 'wallet_address',
	walletVkey: 'wallet_vkey',
} satisfies z.infer<typeof postWalletSchemaOutput>;

export const updateWalletBodyExample = {
	id: 'unique_cuid_v2_of_entry_to_update',
	newCollectionAddress: 'collection_address',
};

export const getWalletLowBalanceRulesQueryExample = {
	walletId: 'unique_cuid_v2_of_wallet',
	onlyLow: 'true',
	includeDisabled: 'false',
};

export const walletLowBalanceRuleExample = {
	id: 'low_balance_rule_id',
	assetUnit: 'lovelace',
	thresholdAmount: '5000000',
	enabled: true,
	status: 'Low',
	lastKnownAmount: '4200000',
	lastCheckedAt: new Date(1713636260),
	lastAlertedAt: new Date(1713636260),
	walletId: 'unique_cuid_v2_of_wallet',
	walletVkey: 'wallet_vkey',
	walletAddress: 'wallet_address',
	walletType: 'Purchasing',
	paymentSourceId: 'payment_source_id',
	network: Network.Preprod,
};

export const createWalletLowBalanceRuleBodyExample = {
	walletId: 'unique_cuid_v2_of_wallet',
	assetUnit: 'lovelace',
	thresholdAmount: '5000000',
	enabled: true,
};

export const updateWalletLowBalanceRuleBodyExample = {
	ruleId: 'low_balance_rule_id',
	thresholdAmount: '7000000',
	enabled: true,
};

export const deleteWalletLowBalanceRuleBodyExample = {
	ruleId: 'low_balance_rule_id',
};
