import { HotWalletType, Network, TransactionStatus } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';
import { lowBalanceRuleSchema, lowBalanceSummarySchema } from './low-balance.schemas';

export const walletListItemSchema = z
	.object({
		id: z.string().describe('Unique identifier for the wallet'),
		paymentSourceId: z.string().describe('Id of the payment source this wallet belongs to'),
		type: z
			.nativeEnum(HotWalletType)
			.describe(
				'Whether this is a Selling (seller side), Purchasing (buyer side) or Funding (treasury that tops up the other two) wallet',
			),
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
	walletType: z
		.nativeEnum(HotWalletType)
		.optional()
		.describe('Filter wallets by type (Selling, Purchasing or Funding)'),
	walletVkey: z.string().max(250).optional().describe('Filter to the single wallet with this payment key hash'),
	walletAddress: z.string().max(250).optional().describe('Filter to wallets with this Cardano address'),
});

export const getWalletListSchemaOutput = z.object({
	Wallets: z.array(walletListItemSchema).describe('Paginated list of hot wallets'),
});

export const getWalletSchemaInput = z.object({
	walletType: z.nativeEnum(HotWalletType).describe('The type of wallet to query'),
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

/**
 * A native asset unit: 56 hex chars of policy id, then an optional hex asset
 * name (asset names are bytes, so an odd number of hex chars cannot exist).
 *
 * `lovelace` is deliberately NOT accepted — ADA is carried by `lovelaceAmount`.
 * Accepting it here silently loses funds: mesh's `toValue` picks lovelace with
 * `assets.find(...)` (first match wins, no summing), and the service prepends
 * its own validated `lovelaceAmount` entry ahead of this list, so a caller's
 * lovelace entry is dropped on the floor with no error.
 */
const ASSET_UNIT_PATTERN = /^[0-9a-fA-F]{56}(?:[0-9a-fA-F]{2})*$/;

/** Positive integer, no leading zeros. Rejects '0', '-5', 'abc', '1e9', '1.5'. */
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

/**
 * 20 digits of lovelace is ~10^20, four orders of magnitude above the 45e15
 * lovelace total supply. This bounds the string handed to BigInt() rather than
 * capping the transfer: the wallet balance is the real limit.
 */
const MAX_LOVELACE_DIGITS = 20;

/**
 * min-UTxO grows with the serialized size of the output's value, and this route
 * enforces a flat 2 ADA floor. Roughly 0.2-0.3 ADA per distinct policy means
 * 2 ADA stops covering the output somewhere past a handful of assets, at which
 * point `build()` fails inside the scheduler rather than at the API. Cap the
 * bundle so that failure mode stays out of reach; a larger payout can raise
 * `lovelaceAmount` or split across transfers.
 */
const MAX_FUND_TRANSFER_ASSETS = 10;

export const postWalletFundSchemaInput = z.object({
	fromWalletAddress: z.string().min(1).max(250).describe('The Cardano address of the hot wallet to send funds from'),
	toAddress: z.string().min(1).max(250).describe('The Cardano address to send funds to'),
	lovelaceAmount: z
		.string()
		.regex(POSITIVE_INTEGER_PATTERN, 'lovelaceAmount must be a positive integer in lovelace')
		.max(MAX_LOVELACE_DIGITS, 'lovelaceAmount is implausibly large')
		.describe('Amount of lovelace to transfer (minimum 2000000 = 2 ADA)')
		// Guarded by the regex above: BigInt() throws a SyntaxError on bad input,
		// and zod does not catch throws inside .transform() — they escape
		// safeParse and surface as a 500 on what is a plain client input error.
		.transform((s) => BigInt(s)),
	assets: z
		.array(
			z.object({
				unit: z
					.string()
					.regex(ASSET_UNIT_PATTERN, 'unit must be a policy id (56 hex chars) followed by the hex asset name')
					.describe('Asset unit: policy id (56 hex chars) followed by the hex asset name. Not "lovelace".'),
				quantity: z
					.string()
					.regex(POSITIVE_INTEGER_PATTERN, 'quantity must be a positive integer')
					.describe('Amount of the asset to transfer, in its smallest unit'),
			}),
		)
		.max(MAX_FUND_TRANSFER_ASSETS)
		// Duplicates are silently wrong rather than rejected downstream: mesh's
		// `toValue` builds the multiasset map with `Map.set`, so a repeated unit
		// is last-wins, not summed.
		.refine((assets) => new Set(assets.map((asset) => asset.unit)).size === assets.length, {
			message: 'assets contains the same unit more than once',
		})
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
		// z.coerce, matching getWalletListSchemaInput.take. The hand-rolled
		// `Math.min(Math.max(Number(s), 1), 100)` this replaces looked like a
		// clamp but laundered a non-numeric string into NaN (every comparison
		// with NaN is false, so both bounds pass it through), which then reached
		// Prisma as `take: NaN` and threw — a 500 on a bad query string.
		limit: z.coerce
			.number()
			.int()
			.min(1)
			.max(100)
			.default(20)
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
