import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { executeHydraConsolidation } from '@/services/hydra-consolidate/execute';

export const consolidateInput = z.object({
	headId: z.string().describe('The Hydra head whose local wallet UTxOs to merge'),
});

export const consolidateOutput = z.object({
	headId: z.string(),
	txId: z.string().describe('The confirmed in-head self-send'),
	inputCount: z.number().int().describe('UTxOs spent'),
	outputCount: z
		.number()
		.int()
		.describe('UTxOs produced: one carrying everything, plus a pure-ADA collateral UTxO when the funds allow it'),
	remainingCount: z
		.number()
		.int()
		.describe(
			'Eligible UTxOs left for another round, because one round spends at most 100. Non-zero means call again.',
		),
});

/**
 * Merge the local participant's in-head UTxOs. Waits for the head to confirm.
 *
 * Unlike a withdrawal, this is one in-head transaction that confirms in about a
 * second, so the request can hold it open and report the outcome directly.
 */
export const consolidateHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: consolidateInput,
	output: consolidateOutput,
	handler: async ({ input }) => await executeHydraConsolidation(input.headId),
});
