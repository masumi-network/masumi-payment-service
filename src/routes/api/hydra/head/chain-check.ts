/**
 * Manual counterpart of the disabled-head chain watch: read the head's state on
 * L1 now, and start the node if the head is no longer open there.
 */

import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { z } from '@masumi/payment-core/zod';
import { HydraHeadInitObservationError } from '@/lib/hydra/hydra/head-init-validation';
import { checkDisabledHeadOnChain } from '@/services/hydra-paused-node-watchdog';

export const checkHeadOnChainInput = z.object({
	id: z.string().min(1).describe('ID of the HydraHead to check'),
});

export const checkHeadOnChainOutput = z.object({
	isOpenOnChain: z.boolean().describe('Whether the newest state-token transaction leaves the head Open'),
	latestTxHash: z.string().describe('Newest transaction that moved the head state token'),
	nodeStart: z
		.enum(['requested', 'head-closing', 'no-participant', 'no-admin-token', 'failed'])
		.nullable()
		.describe('Outcome of starting the node, when the head is no longer open; null otherwise'),
});

export const checkHeadOnChainPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: checkHeadOnChainInput,
	output: checkHeadOnChainOutput,
	handler: async ({ input }) => {
		try {
			return await checkDisabledHeadOnChain(input.id);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof HydraHeadInitObservationError) throw createHttpError(503, message);
			if (message === 'Hydra head not found') throw createHttpError(404, message);
			throw createHttpError(502, `Could not read the head state on chain: ${message}`);
		}
	},
});
