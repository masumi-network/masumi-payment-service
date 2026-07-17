import { z } from '@masumi/payment-core/zod';
import { CONSTANTS } from '@masumi/payment-core/config';
import { lowBalanceSummarySchema } from '@/routes/api/wallet/low-balance.schemas';

// 18 digits keeps any accepted value below Postgres' BigInt (i64) maximum
// (~9.2e18) — an unbounded digit string overflowed the column and surfaced as
// a 500 — while still allowing far more than the total lovelace supply.
const lovelaceAmountString = z.string().regex(/^\d{1,18}$/);

// 'lovelace', or a policy id (56 hex) followed by the hex asset name — the same
// convention low-balance rules use, so a rule and its top-up policy name the
// same asset the same way.
const assetUnitString = z
	.string()
	.min(1)
	.max(250)
	.regex(/^(lovelace|[0-9a-fA-F]{56}[0-9a-fA-F]*)$/, 'assetUnit must be "lovelace" or policyId + hex asset name');

const fundDistributionAssetConfigSchema = z.object({
	assetUnit: assetUnitString.describe('"lovelace" for ADA, otherwise policy id + hex asset name'),
	warningThreshold: z.string().describe("Balance below this triggers a batched topup, in the asset's smallest unit"),
	criticalThreshold: z
		.string()
		.describe("Balance below this triggers an immediate topup, in the asset's smallest unit"),
	topupAmount: z.string().describe("Amount to send per topup, in the asset's smallest unit"),
});

const fundDistributionConfigSchema = z.object({
	id: z.string().describe('Config id'),
	enabled: z.boolean().describe('Whether automatic distribution is enabled'),
	batchWindowMs: z.number().int().describe('Milliseconds to wait before sending batched warning topups'),
	Assets: z
		.array(fundDistributionAssetConfigSchema)
		.describe(
			'Per-asset policy. Thresholds cannot be shared across assets — 20 USDM and 20 ADA are unrelated quantities — so each asset the fund wallet should top up needs its own entry',
		),
});

// Amounts are per asset, so the input carries the asset's own units. The
// min-UTxO floor is only meaningful for lovelace; a token quantity has no such
// bound, and imposing the ADA floor on it would reject e.g. 1 USDM.
const assetConfigInput = z.object({
	assetUnit: assetUnitString.describe('"lovelace" for ADA, otherwise policy id + hex asset name'),
	warningThreshold: lovelaceAmountString.describe("Warning threshold in the asset's smallest unit"),
	criticalThreshold: lovelaceAmountString.describe("Critical threshold in the asset's smallest unit"),
	topupAmount: lovelaceAmountString.describe("Amount sent per topup, in the asset's smallest unit"),
});

export const getFundWalletSchemaInput = z.object({
	id: z.string().min(1).max(250).optional().describe('Fund wallet id'),
	paymentSourceId: z.string().min(1).max(250).optional().describe('Payment source id'),
});

export const getFundWalletSchemaOutput = z
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

export const postFundWalletSchemaInput = z.object({
	paymentSourceId: z.string().min(1).max(250).describe('Payment source to associate the fund wallet with'),
	walletMnemonic: z.string().min(1).max(1500).describe('24-word mnemonic phrase for the fund wallet'),
	Assets: z
		.array(assetConfigInput)
		.min(1)
		.describe(
			'Per-asset distribution policy, one entry per asset this wallet should top up. Use assetUnit "lovelace" for ADA. The fund wallet must itself hold each asset it distributes, and a token top-up also sends ADA to satisfy the min-UTxO of its output',
		),
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
	enabled: z.boolean().optional().describe('Enable or disable automatic distribution'),
	Assets: z
		.array(assetConfigInput)
		.optional()
		.describe(
			'Replaces the per-asset policy wholesale. Assets omitted from this list stop being topped up; omit the field entirely to leave the policy untouched',
		),
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
