import { Network, RPCProvider } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { paymentSourceExtendedCreateSchemaOutput } from './schemas';

export const paymentSourceExtendedExample = {
	id: 'cuid_v2_auto_generated',
	createdAt: new Date(1713636260),
	updatedAt: new Date(1713636260),
	network: Network.Mainnet,
	policyId: 'policy_id',
	smartContractAddress: 'address_of_the_smart_contract',
	PaymentSourceConfig: {
		rpcProviderApiKey: 'rpc_provider_api_key_blockfrost',
		rpcProvider: RPCProvider.Blockfrost,
	},
	lastIdentifierChecked: 'identifier',
	syncInProgress: true,
	lastCheckedAt: new Date(1713636260),
	AdminWallets: [
		{ walletAddress: 'wallet_address', order: 0 },
		{ walletAddress: 'wallet_address', order: 1 },
		{ walletAddress: 'wallet_address', order: 2 },
	],
	PurchasingWallets: [
		{
			collectionAddress: null,
			note: 'note',
			walletVkey: 'wallet_vkey',
			walletAddress: 'wallet_address',
			id: 'unique_cuid_v2_auto_generated',
		},
		{
			collectionAddress: 'send_refunds_to_this_address',
			note: 'note',
			walletVkey: 'wallet_vkey',
			walletAddress: 'wallet_address',
			id: 'unique_cuid_v2_auto_generated',
		},
	],
	SellingWallets: [
		{
			collectionAddress: 'null_will_use_the_selling_wallet_as_revenue_address',
			note: 'note',
			walletVkey: 'wallet_vkey',
			walletAddress: 'wallet_address',
			id: 'unique_cuid_v2_auto_generated',
		},
		{
			collectionAddress: 'send_revenue_to_this_address',
			note: 'note',
			walletVkey: 'wallet_vkey',
			walletAddress: 'wallet_address',
			id: 'unique_cuid_v2_auto_generated',
		},
	],
	FeeReceiverNetworkWallet: {
		walletAddress: 'wallet_address',
	},
	feeRatePermille: 50,
} satisfies z.infer<typeof paymentSourceExtendedCreateSchemaOutput>;

export const listPaymentSourceExtendedQueryExample = {
	take: 10,
	cursorId: 'cursor_id',
};

export const listPaymentSourceExtendedResponseExample = {
	ExtendedPaymentSources: [
		{
			id: 'cuid_v2_auto_generated',
			createdAt: new Date(1713636260),
			updatedAt: new Date(1713636260),
			network: Network.Mainnet,
			feeRatePermille: 50,
			syncInProgress: true,
			policyId: 'policy_id',
			smartContractAddress: 'address_of_the_smart_contract',
			AdminWallets: [
				{ walletAddress: 'wallet_address', order: 0 },
				{ walletAddress: 'wallet_address', order: 1 },
				{ walletAddress: 'wallet_address', order: 2 },
			],
			FeeReceiverNetworkWallet: {
				walletAddress: 'wallet_address',
			},
			lastCheckedAt: new Date(1713636260),
			lastIdentifierChecked: 'identifier',
			PaymentSourceConfig: {
				rpcProviderApiKey: 'rpc_provider_api_key_blockfrost',
				rpcProvider: RPCProvider.Blockfrost,
			},
			PurchasingWallets: [
				{
					collectionAddress: null,
					note: 'note',
					walletVkey: 'wallet_vkey',
					walletAddress: 'wallet_address',
					id: 'unique_cuid_v2_auto_generated',
				},
				{
					collectionAddress: 'send_refunds_to_this_address',
					note: 'note',
					walletVkey: 'wallet_vkey',
					walletAddress: 'wallet_address',
					id: 'unique_cuid_v2_auto_generated',
				},
			],
			SellingWallets: [
				{
					collectionAddress: 'null_will_use_selling_wallet_as_revenue_address',
					note: 'note',
					walletVkey: 'wallet_vkey',
					walletAddress: 'wallet_address',
					id: 'unique_cuid_v2_auto_generated',
				},
				{
					collectionAddress: 'send_revenue_to_this_address',
					note: 'note',
					walletVkey: 'wallet_vkey',
					walletAddress: 'wallet_address',
					id: 'unique_cuid_v2_auto_generated',
				},
			],
		},
	],
};

export const createPaymentSourceExtendedBodyExample = {
	network: Network.Preprod,
	PaymentSourceConfig: {
		rpcProviderApiKey: 'rpc_provider_api_key',
		rpcProvider: RPCProvider.Blockfrost,
	},
	AdminWallets: [
		{ walletAddress: 'wallet_address_1' },
		{ walletAddress: 'wallet_address_2' },
		{ walletAddress: 'wallet_address_3' },
	],
	FeeReceiverNetworkWallet: { walletAddress: 'wallet_address' },
	feeRatePermille: 50,
	PurchasingWallets: [
		{
			walletMnemonic: 'wallet mnemonic',
			note: 'note',
			collectionAddress: null,
		},
	],
	SellingWallets: [
		{
			walletMnemonic: 'wallet mnemonic',
			note: 'note',
			collectionAddress: 'collection_address',
		},
	],
};

export const updatePaymentSourceExtendedBodyExample = {
	id: 'unique_cuid_v2',
	lastIdentifierChecked: 'optional_identifier',
	PaymentSourceConfig: {
		rpcProviderApiKey: 'rpc_provider_api_key',
		rpcProvider: RPCProvider.Blockfrost,
	},
	AddPurchasingWallets: [
		{
			walletMnemonic: 'wallet_mnemonic',
			note: 'note',
			collectionAddress: 'refunds_will_be_sent_to_this_address',
		},
	],
	AddSellingWallets: [
		{
			walletMnemonic: 'wallet_mnemonic',
			note: 'note',
			collectionAddress: 'revenue_will_be_sent_to_this_address',
		},
	],
	RemovePurchasingWallets: [{ id: 'unique_cuid_v2' }],
	RemoveSellingWallets: [{ id: 'unique_cuid_v2' }],
};

export const deletePaymentSourceExtendedBodyExample = {
	id: 'unique_cuid_v2_auto_generated',
};
