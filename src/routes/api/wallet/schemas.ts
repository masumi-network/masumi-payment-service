import { HotWalletType, Network } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import { lowBalanceRuleSchema, lowBalanceSummarySchema } from './low-balance.schemas';

export const walletListItemSchema = z
	.object({
		id: z.string().describe('Unique identifier for the wallet'),
		paymentSourceId: z.string().describe('Id of the payment source this wallet belongs to'),
		type: z
			.nativeEnum(HotWalletType)
			.describe('Whether this is a Selling (seller side) or Purchasing (buyer side) wallet'),
		walletVkey: z.string().describe('Payment key hash of the wallet'),
		walletAddress: z.string().describe('Cardano address of the wallet'),
		collectionAddress: z.string().nullable().describe('Optional collection address for this wallet. Null if not set'),
		note: z.string().nullable().describe('Optional note about this wallet. Null if not set'),
		LowBalanceSummary: lowBalanceSummarySchema.describe('Aggregated low-balance status for the wallet'),
	})
	.openapi('WalletListItem');

export const getWalletListSchemaInput = z.object({
	take: z.coerce.number().min(1).max(100).default(10).describe('The number of wallets to return'),
	cursorId: z
		.string()
		.max(250)
		.optional()
		.describe('Used to paginate through the wallets (provide the id of the last returned wallet)'),
	paymentSourceId: z.string().max(250).optional().describe('Filter wallets to a single payment source'),
	walletType: z.nativeEnum(HotWalletType).optional().describe('Filter wallets by type (Selling or Purchasing)'),
	walletVkey: z.string().max(250).optional().describe('Filter to the single wallet with this payment key hash'),
});

export const getWalletListSchemaOutput = z.object({
	Wallets: z.array(walletListItemSchema).describe('Paginated list of hot wallets'),
});

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
		LowBalanceSummary: lowBalanceSummarySchema.describe('Aggregated low-balance state for this wallet'),
		LowBalanceRules: z
			.array(lowBalanceRuleSchema)
			.describe('Configured low-balance rules for this wallet, including current deduped state'),
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
