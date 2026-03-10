import { Network } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';

export const getWalletSchemaInput = z.object({
	walletType: z.enum(['Selling', 'Purchasing']).describe('The type of wallet to query'),
	id: z.string().min(1).max(250).describe('The id of the wallet to query'),
	includeSecret: z
		.string()
		.default('false')
		.transform((s) => s.toLowerCase() === 'true')
		.describe('Whether to include the decrypted secret in the response'),
});

export const getWalletSchemaOutput = z
	.object({
		Secret: z
			.object({
				createdAt: z.date().describe('Timestamp when the secret was created'),
				updatedAt: z.date().describe('Timestamp when the secret was last updated'),
				mnemonic: z.string().describe('Decrypted 24-word mnemonic phrase for the wallet'),
			})
			.optional()
			.describe('Wallet secret (mnemonic). Only included if includeSecret is true'),
		PendingTransaction: z
			.object({
				createdAt: z.date().describe('Timestamp when the pending transaction was created'),
				updatedAt: z.date().describe('Timestamp when the pending transaction was last updated'),
				hash: z.string().nullable().describe('Transaction hash of the pending transaction. Null if not yet submitted'),
				lastCheckedAt: z
					.date()
					.nullable()
					.describe('Timestamp when the pending transaction was last checked. Null if never checked'),
			})
			.nullable()
			.describe('Pending transaction for this wallet. Null if no transaction is pending'),
		note: z.string().nullable().describe('Optional note about this wallet. Null if not set'),
		walletVkey: z.string().describe('Payment key hash of the wallet'),
		walletAddress: z.string().describe('Cardano address of the wallet'),
		collectionAddress: z.string().nullable().describe('Collection address for this wallet. Null if not set'),
	})
	.openapi('Wallet');

export const postWalletSchemaInput = z.object({
	network: z.nativeEnum(Network).describe('The network the Cardano wallet will be used on'),
});

export const postWalletSchemaOutput = z
	.object({
		walletMnemonic: z
			.string()
			.describe('24-word mnemonic phrase for the newly generated wallet. IMPORTANT: Backup this mnemonic securely'),
		walletAddress: z.string().describe('Cardano address of the newly generated wallet'),
		walletVkey: z.string().describe('Payment key hash of the newly generated wallet'),
	})
	.openapi('GeneratedWalletSecret');

export const patchWalletSchemaInput = z.object({
	id: z.string().min(1).max(250).describe('The id of the wallet to update'),
	newCollectionAddress: z
		.string()
		.max(250)
		.nullable()
		.describe('The new collection address to set for this wallet. Pass null to clear.'),
});

export const patchWalletSchemaOutput = getWalletSchemaOutput;
