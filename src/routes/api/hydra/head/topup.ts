import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import type { CommitUtxoFilter } from '@/lib/hydra';
import { executeHydraTopup } from '@/services/hydra-topup/execute';

export const topupInput = z.object({
	headId: z.string().describe('The Hydra head to top up'),
	assetFilter: z
		.enum(['all', 'ada-only'])
		.optional()
		.default('all')
		.describe('Which plain wallet UTxOs to commit: all, or ADA-only (ignored when assetUnit is set)'),
	assetUnit: z
		.string()
		.regex(/^[0-9a-fA-F]{56,120}$/)
		.optional()
		.describe('Commit only UTxOs containing this native-asset unit (policyId + assetName hex)'),
});

export const topupOutput = z.object({
	headId: z.string(),
	topupId: z.string(),
	depositTxHash: z.string(),
	confirmed: z.boolean().describe('Whether the deposit is already confirmed on L1 by the independent observer'),
	committedLovelace: z.string(),
	committedAssets: z.record(z.string(), z.string()).describe('Committed native-asset amounts keyed by unit'),
});

/**
 * Repeatable incremental-commit (top-up) of additional funds into an already-Open
 * head. A thin wrapper over executeHydraTopup, the shared flow also used by the
 * automatic low-balance top-up; it commits every matching UTxO (unbounded).
 */
export const topupHeadPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: topupInput,
	output: topupOutput,
	handler: async ({ input }) => {
		const filter: CommitUtxoFilter = input.assetUnit ? { unit: input.assetUnit } : input.assetFilter;
		const result = await executeHydraTopup({ headId: input.headId, filter });
		return {
			headId: result.headId,
			topupId: result.topupId,
			depositTxHash: result.depositTxHash,
			confirmed: result.confirmed,
			committedLovelace: result.committedLovelace.toString(),
			committedAssets: result.committedAssets,
		};
	},
});
