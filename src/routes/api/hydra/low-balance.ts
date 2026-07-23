import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import createHttpError from 'http-errors';
import { LowBalanceStatus } from '@/generated/prisma/client';
import {
	deleteHydraLowBalanceRule,
	listHydraLowBalanceRules,
	upsertHydraLowBalanceRule,
} from '@/services/hydra-low-balance/rules';

const amountString = z
	.string()
	.regex(/^\d+$/, 'Must be a non-negative integer in the asset base unit')
	.describe('Amount in the asset base unit (lovelace for ADA)');

function parseBigInt(value: string, label: string): bigint {
	try {
		return BigInt(value);
	} catch {
		throw createHttpError(400, `${label} must be an integer`);
	}
}

export const hydraLowBalanceRuleSchema = z
	.object({
		id: z.string(),
		createdAt: z.string(),
		updatedAt: z.string(),
		hydraLocalParticipantId: z.string(),
		assetUnit: z.string(),
		thresholdAmount: z.string(),
		enabled: z.boolean(),
		topupEnabled: z.boolean(),
		topupAmount: z.string().nullable(),
		status: z.nativeEnum(LowBalanceStatus),
		lastKnownAmount: z.string().nullable(),
		lastCheckedAt: z.string().nullable(),
		lastAlertedAt: z.string().nullable(),
	})
	.openapi('HydraLowBalanceRule');

export const listHydraLowBalanceRulesSchemaInput = z.object({
	hydraLocalParticipantId: z.string().optional().describe('Filter rules by local participant'),
});

export const listHydraLowBalanceRulesSchemaOutput = z.object({
	rules: z.array(hydraLowBalanceRuleSchema),
});

export const setHydraLowBalanceRuleSchemaInput = z.object({
	hydraLocalParticipantId: z.string().describe('Local participant whose in-head balance to monitor'),
	assetUnit: z.string().describe('"lovelace" or a policyId+assetName hex unit'),
	thresholdAmount: amountString.describe('Alert when the in-head balance falls below this'),
	enabled: z.boolean().optional().default(true),
	topupEnabled: z.boolean().optional().default(false).describe('Auto top-up from the assigned funding wallet when low'),
	topupAmount: amountString.optional().describe('Target amount an auto top-up tries to reach (whole-UTxO bounded)'),
});

export const setHydraLowBalanceRuleSchemaOutput = z.object({
	rule: hydraLowBalanceRuleSchema,
});

export const deleteHydraLowBalanceRuleSchemaInput = z.object({
	id: z.string().describe('Low-balance rule id'),
});

export const deleteHydraLowBalanceRuleSchemaOutput = z.object({
	id: z.string(),
});

export const listHydraLowBalanceRulesGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listHydraLowBalanceRulesSchemaInput,
	output: listHydraLowBalanceRulesSchemaOutput,
	handler: async ({ input }) => ({ rules: await listHydraLowBalanceRules(input.hydraLocalParticipantId) }),
});

export const setHydraLowBalanceRulePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: setHydraLowBalanceRuleSchemaInput,
	output: setHydraLowBalanceRuleSchemaOutput,
	handler: async ({ input }) => {
		const rule = await upsertHydraLowBalanceRule({
			hydraLocalParticipantId: input.hydraLocalParticipantId,
			assetUnit: input.assetUnit,
			thresholdAmount: parseBigInt(input.thresholdAmount, 'thresholdAmount'),
			enabled: input.enabled,
			topupEnabled: input.topupEnabled,
			topupAmount: input.topupAmount != null ? parseBigInt(input.topupAmount, 'topupAmount') : null,
		});
		return { rule };
	},
});

export const deleteHydraLowBalanceRuleDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: deleteHydraLowBalanceRuleSchemaInput,
	output: deleteHydraLowBalanceRuleSchemaOutput,
	handler: async ({ input }) => {
		await deleteHydraLowBalanceRule(input.id);
		return { id: input.id };
	},
});
