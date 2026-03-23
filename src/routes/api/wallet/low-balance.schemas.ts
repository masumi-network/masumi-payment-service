import { Network, HotWalletType } from '@/generated/prisma/client';
import { LowBalanceStatus } from '@/generated/prisma/enums';
import { z } from '@/utils/zod-openapi';

const booleanQuery = (description: string) =>
	z
		.string()
		.default('false')
		.transform((value) => value.toLowerCase() === 'true')
		.describe(description);

export const lowBalanceSummarySchema = z.object({
	isLow: z.boolean().describe('Whether any enabled low-balance rule for this wallet is currently below threshold'),
	lowRuleCount: z.number().int().min(0).describe('How many enabled rules for this wallet are currently in low state'),
	lastCheckedAt: z
		.date()
		.nullable()
		.describe('Timestamp of the latest low-balance evaluation across this wallet rules. Null if never checked'),
});

export const lowBalanceRuleSchema = z.object({
	id: z.string().describe('Unique identifier for the low-balance rule'),
	assetUnit: z.string().describe('Raw on-chain asset unit, for example lovelace or a full policy+asset identifier'),
	thresholdAmount: z.string().describe('Threshold in raw on-chain units used to determine low balance'),
	enabled: z.boolean().describe('Whether the rule is active'),
	status: z.nativeEnum(LowBalanceStatus).describe('Current deduped state of the rule'),
	lastKnownAmount: z
		.string()
		.nullable()
		.describe('Last observed balance for this asset in raw on-chain units. Null if never checked'),
	lastCheckedAt: z.date().nullable().describe('Timestamp when the rule was last evaluated. Null if never checked'),
	lastAlertedAt: z
		.date()
		.nullable()
		.describe('Timestamp when the wallet last entered low balance for this rule. Null if never alerted'),
});

export const walletLowBalanceRuleWithWalletSchema = lowBalanceRuleSchema.extend({
	walletId: z.string().describe('Hot wallet id the rule belongs to'),
	walletVkey: z.string().describe('Wallet verification key'),
	walletAddress: z.string().describe('Wallet address'),
	walletType: z.nativeEnum(HotWalletType).describe('Hot wallet type'),
	paymentSourceId: z.string().describe('Payment source id owning the wallet'),
	network: z.nativeEnum(Network).describe('Wallet network'),
});

export const getWalletLowBalanceRulesSchemaInput = z.object({
	walletId: z.string().optional().describe('Optional: filter rules by wallet id'),
	paymentSourceId: z.string().optional().describe('Optional: filter rules by payment source id'),
	onlyLow: booleanQuery('Whether to return only rules currently in low state'),
	includeDisabled: booleanQuery('Whether to include disabled rules'),
});

export const getWalletLowBalanceRulesSchemaOutput = z.object({
	Rules: z.array(walletLowBalanceRuleWithWalletSchema),
});

export const postWalletLowBalanceRuleSchemaInput = z.object({
	walletId: z.string().min(1).max(250).describe('Hot wallet id to attach the rule to'),
	assetUnit: z
		.string()
		.min(1)
		.max(500)
		.describe('Raw on-chain asset unit, for example lovelace or a policy+asset identifier'),
	thresholdAmount: z.string().regex(/^\d+$/).describe('Threshold in raw on-chain units. Example: 5000000 for 5 ADA'),
	enabled: z.boolean().default(true).describe('Whether the rule should start enabled'),
});

export const postWalletLowBalanceRuleSchemaOutput = walletLowBalanceRuleWithWalletSchema;

export const patchWalletLowBalanceRuleSchemaInput = z.object({
	ruleId: z.string().min(1).max(250).describe('Low-balance rule id to update'),
	thresholdAmount: z.string().regex(/^\d+$/).optional().describe('Updated threshold in raw on-chain units'),
	enabled: z.boolean().optional().describe('Updated enabled state'),
});

export const patchWalletLowBalanceRuleSchemaOutput = walletLowBalanceRuleWithWalletSchema;

export const deleteWalletLowBalanceRuleSchemaInput = z.object({
	ruleId: z.string().min(1).max(250).describe('Low-balance rule id to delete'),
});

export const deleteWalletLowBalanceRuleSchemaOutput = z.object({
	ruleId: z.string().describe('Deleted rule id'),
	deletedAt: z.date().describe('Timestamp when the rule was deleted'),
});
