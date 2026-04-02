import { Network, TransactionStatus } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { getWalletSchemaOutput, postWalletSchemaOutput, postWalletFundSchemaOutput } from './schemas';

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

export const fundTransferExample = {
	id: 'unique_cuid_v2_of_fund_transfer',
	status: TransactionStatus.Confirmed,
	txHash: 'a3f8c12d9e4b71d2f0e5c8a9b3d6e7f1a2b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8',
	toAddress: 'addr_test1qz8x...purchasing_wallet_address',
	lovelaceAmount: '100000000',
	createdAt: new Date(1713636260),
	updatedAt: new Date(1713636260),
	lastCheckedAt: new Date(1713636260),
	errorNote: null,
} satisfies z.infer<typeof postWalletFundSchemaOutput>;

export const postWalletFundBodyExample = {
	fromWalletAddress: 'addr_test1qx9...source_wallet_address',
	toAddress: 'addr_test1qz8x...destination_address',
	lovelaceAmount: '100000000',
};

export const getWalletFundQueryExample = {
	hotWalletId: 'unique_cuid_v2_of_wallet',
	limit: '20',
};
