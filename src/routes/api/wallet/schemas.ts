import { Network, TransactionStatus } from '@/generated/prisma/client';
import { z } from '@/utils/zod-openapi';
import { lowBalanceRuleSchema, lowBalanceSummarySchema } from './low-balance.schemas';

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

export const postWalletFundSchemaInput = z.object({
	fromWalletAddress: z.string().min(1).max(250).describe('The Cardano address of the hot wallet to send funds from'),
	toAddress: z.string().min(1).max(250).describe('The Cardano address to send funds to'),
	lovelaceAmount: z
		.string()
		.min(1)
		.describe('Amount of lovelace to transfer (minimum 2000000 = 2 ADA)')
		.transform((s) => BigInt(s)),
	assets: z
		.array(
			z.object({
				unit: z.string().min(1).describe('Asset unit (policy id + hex asset name, or "lovelace")'),
				quantity: z.string().min(1).describe('Amount of the asset to transfer'),
			}),
		)
		.optional()
		.describe('Additional native assets to transfer alongside lovelace'),
});

const fundTransferSchema = z
	.object({
		id: z.string().describe('Unique identifier of the fund transfer'),
		status: z.nativeEnum(TransactionStatus).describe('Current status of the fund transfer'),
		txHash: z.string().nullable().describe('Cardano transaction hash. Null until submitted to blockchain'),
		toAddress: z.string().describe('Destination Cardano address'),
		lovelaceAmount: z.string().describe('Amount transferred in lovelace'),
		assets: z
			.array(z.object({ unit: z.string(), quantity: z.string() }))
			.nullable()
			.describe('Additional native assets included in this transfer. Null if lovelace-only.'),
		createdAt: z.date().describe('Timestamp when the transfer was requested'),
		updatedAt: z.date().describe('Timestamp when the transfer was last updated'),
		lastCheckedAt: z.date().nullable().describe('Timestamp when the blockchain was last polled for confirmation'),
		errorNote: z.string().nullable().describe('Error message if the transfer failed'),
	})
	.openapi('WalletFundTransfer');

export const postWalletFundSchemaOutput = fundTransferSchema;

export const getWalletFundSchemaInput = z
	.object({
		id: z.string().min(1).max(250).optional().describe('Query a specific fund transfer by id'),
		hotWalletId: z.string().min(1).max(250).optional().describe('Query all fund transfers for a wallet by internal id'),
		walletAddress: z
			.string()
			.min(1)
			.max(250)
			.optional()
			.describe('Query all fund transfers for a wallet by its Cardano address'),
		cursorId: z.string().min(1).max(250).optional().describe('Cursor for pagination'),
		limit: z
			.string()
			.default('20')
			.transform((s) => Math.min(Math.max(Number(s), 1), 100))
			.describe('Number of results to return (1-100, default 20)'),
	})
	.refine((data) => data.id != null || data.hotWalletId != null || data.walletAddress != null, {
		message: 'Either id, hotWalletId, or walletAddress must be provided',
	});

export const getWalletFundSchemaOutput = z
	.object({
		transfers: z.array(fundTransferSchema).describe('List of fund transfers'),
	})
	.openapi('WalletFundTransferList');
