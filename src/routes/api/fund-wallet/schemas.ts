import { z } from '@/utils/zod-openapi';
import { lowBalanceSummarySchema } from '@/routes/api/wallet/low-balance.schemas';

const fundDistributionConfigSchema = z.object({
	id: z.string().describe('Config id'),
	enabled: z.boolean().describe('Whether automatic distribution is enabled'),
	warningThreshold: z.string().describe('Balance below this triggers a batched topup (lovelace)'),
	criticalThreshold: z.string().describe('Balance below this triggers an immediate topup (lovelace)'),
	topupAmount: z.string().describe('Amount to send per topup (lovelace)'),
	batchWindowMs: z.number().int().describe('Milliseconds to wait before sending batched warning topups'),
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
	warningThreshold: z.string().regex(/^\d+$/).describe('Warning balance threshold in lovelace'),
	criticalThreshold: z.string().regex(/^\d+$/).describe('Critical balance threshold in lovelace'),
	topupAmount: z.string().regex(/^\d+$/).describe('Amount to send per topup in lovelace'),
	batchWindowMs: z
		.number()
		.int()
		.min(1000)
		.default(300000)
		.optional()
		.describe('Batch window in milliseconds (default 5 min)'),
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
	warningThreshold: z.string().regex(/^\d+$/).optional().describe('New warning threshold in lovelace'),
	criticalThreshold: z.string().regex(/^\d+$/).optional().describe('New critical threshold in lovelace'),
	topupAmount: z.string().regex(/^\d+$/).optional().describe('New topup amount in lovelace'),
	batchWindowMs: z.number().int().min(1000).optional().describe('New batch window in milliseconds'),
});

export const patchFundWalletSchemaOutput = z
	.object({
		id: z.string().describe('Fund wallet id'),
		FundDistributionConfig: fundDistributionConfigSchema.describe('Updated distribution config'),
	})
	.openapi('FundWalletUpdated');

export const deleteFundWalletSchemaInput = z.object({
	id: z.string().min(1).max(250).describe('Fund wallet id to delete'),
});

export const deleteFundWalletSchemaOutput = z
	.object({
		id: z.string().describe('Deleted fund wallet id'),
	})
	.openapi('FundWalletDeleted');
