/**
 * Manual counterpart of the disabled-head chain watch: read the head's state on
 * L1 now, and stop or start its node to match.
 */

import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import createHttpError, { isHttpError } from 'http-errors';
import { z } from '@masumi/payment-core/zod';
import { HydraHeadInitObservationError } from '@/lib/hydra/hydra/head-init-validation';
import { convergeDisabledHeadNode } from '@/services/hydra-paused-node-watchdog';

export const checkHeadOnChainInput = z.object({
	id: z.string().min(1).describe('ID of the HydraHead to check'),
});

export const checkHeadOnChainOutput = z.object({
	chainState: z
		.enum(['open', 'closed', 'gone'])
		.describe('Head state after its newest state-token transaction; gone means fanned out'),
	latestTxHash: z.string().describe('Newest transaction that moved the head state token'),
	nodeAction: z
		.enum(['stop', 'start'])
		.nullable()
		.describe('What was asked of the node; null when nothing was (head enabled, or gone)'),
	nodeOutcome: z
		.enum(['requested', 'head-closing', 'no-participant', 'no-admin-token', 'failed'])
		.nullable()
		.describe('Outcome of the node request; null when no request was sent'),
});

export const checkHeadOnChainPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: checkHeadOnChainInput,
	output: checkHeadOnChainOutput,
	handler: async ({ input }) => {
		try {
			return await convergeDisabledHeadNode(input.id, 'operator chain check: head is disabled and open on L1');
		} catch (error) {
			if (isHttpError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof HydraHeadInitObservationError) throw createHttpError(503, message);
			throw createHttpError(502, `Could not read the head state on chain: ${message}`);
		}
	},
});
