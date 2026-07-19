import { z } from '@masumi/payment-core/zod';
import { CONSTANTS } from '@masumi/payment-core/config';
import { lowBalanceSummarySchema } from '@/routes/api/wallet/low-balance.schemas';

// A fund wallet is now purely a funding source: its config carries no per-asset
// thresholds or amounts. The top-up trigger and amount live on each hot wallet's
// low-balance rule.
const fundDistributionConfigSchema = z.object({
	id: z.string().describe('Config id'),
	enabled: z.boolean().describe('Whether this wallet is an active funding source'),
	batchWindowMs: z.number().int().describe('Milliseconds to wait before sending batched topups'),
});

export const getFundWalletSchemaInput = z.object({
	id: z.string().min(1).max(250).optional().describe('Fund wallet id'),
	paymentSourceId: z.string().min(1).max(250).optional().describe('Payment source id'),
});

export const fundWalletSchema = z
	.object({
		id: z.string().describe('Fund wallet id'),
		walletAddress: z.string().describe('Cardano address of the fund wallet'),
		walletVkey: z.string().describe('Payment key hash'),
		note: z.string().nullable().describe('Optional note'),
		paymentSourceId: z.string().describe('Associated payment source id'),
		lockedAt: z.date().nullable().describe('Timestamp when wallet was locked. Null if not locked'),
		LowBalanceSummary: lowBalanceSummarySchema,
		FundDistributionConfig: fundDistributionConfigSchema.nullable().describe('Distribution configuration'),
		pendingRequestCount: z.number().int().describe('Number of pending distribution requests'),
	})
	.openapi('FundWallet');

// A payment source may have several fund wallets (redundancy / capacity), so the
// list endpoint returns all of them for the source.
export const getFundWalletSchemaOutput = z
	.object({
		FundWallets: z.array(fundWalletSchema).describe('Fund wallets for the payment source'),
	})
	.openapi('FundWalletList');

export const postFundWalletSchemaInput = z.object({
	paymentSourceId: z.string().min(1).max(250).describe('Payment source to associate the fund wallet with'),
	walletMnemonic: z.string().min(1).max(1500).describe('BIP-39 mnemonic phrase for the fund wallet (12-24 words)'),
	batchWindowMs: z
		.number()
		.int()
		.min(1000)
		.max(CONSTANTS.FUND_DISTRIBUTION_MAX_BATCH_WINDOW_MS)
		.default(CONSTANTS.FUND_DISTRIBUTION_DEFAULT_BATCH_WINDOW_MS)
		.optional()
		.describe('Batch window in milliseconds (default 5 min, max 24 h)'),
	note: z.string().max(250).optional().describe('Optional note for this fund wallet'),
});

export const postFundWalletSchemaOutput = z
	.object({
		id: z.string().describe('Fund wallet id'),
		walletAddress: z.string().describe('Cardano address'),
		walletVkey: z.string().describe('Payment key hash'),
		paymentSourceId: z.string().describe('Associated payment source id'),
		FundDistributionConfig: fundDistributionConfigSchema.describe('Created distribution config'),
	})
	.openapi('FundWalletCreated');

export const patchFundWalletSchemaInput = z.object({
	id: z.string().min(1).max(250).describe('Fund wallet id to update'),
	enabled: z.boolean().optional().describe('Enable or disable this wallet as a funding source'),
	batchWindowMs: z
		.number()
		.int()
		.min(1000)
		.max(CONSTANTS.FUND_DISTRIBUTION_MAX_BATCH_WINDOW_MS)
		.optional()
		.describe('New batch window in milliseconds (max 24 h)'),
});

export const patchFundWalletSchemaOutput = z
	.object({
		id: z.string().describe('Fund wallet id'),
		FundDistributionConfig: fundDistributionConfigSchema.describe('Updated distribution config'),
	})
	.openapi('FundWalletUpdated');

export const deleteFundWalletSchemaInput = z.object({
	id: z.string().min(1).max(250).describe('Fund wallet id to delete'),
	force: z
		.boolean()
		.optional()
		.describe(
			'Delete even if the wallet still holds funds, or if the balance cannot be checked. Deletion makes the mnemonic unexportable, so the remaining balance would be recoverable only with direct database access',
		),
});

export const deleteFundWalletSchemaOutput = z
	.object({
		id: z.string().describe('Deleted fund wallet id'),
	})
	.openapi('FundWalletDeleted');
