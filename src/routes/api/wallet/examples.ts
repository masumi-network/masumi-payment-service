import { Network } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { getWalletSchemaOutput, postWalletSchemaOutput } from './schemas';

export const walletExample = {
	walletVkey: 'wallet_vkey',
	note: 'note',
	PendingTransaction: null,
	walletAddress: 'wallet_address',
	collectionAddress: 'collection_address',
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
