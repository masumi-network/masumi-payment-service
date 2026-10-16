/**
 * Pause and resume a Hydra Host for maintenance, such as an image upgrade.
 *
 * A pause first refuses new work on the Host's heads, then stops their nodes
 * once in-flight work has settled. Keep a pause short: a stopped node cannot
 * contest a close, and reserved L2 actions are parked after a little over
 * three hours.
 */

import { adminAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { checkIsAllowedNetworkOrThrowUnauthorized } from '@masumi/payment-core/auth-middleware';
import { z } from '@masumi/payment-core/zod';
import { readHydraHostNetwork } from '@/services/hydra-host/registry';
import { getHydraHostPauseState, pauseHydraHost, resumeHydraHost } from '@/services/hydra-host/pause';

export const hydraHostPauseStateSchema = z
	.object({
		hostId: z.string(),
		phase: z
			.enum(['Active', 'Draining', 'Stopping', 'Paused'])
			.describe(
				'Draining: new work refused, waiting for in-flight work. Stopping: nodes asked to stop. Paused: every node reports Stopped.',
			),
		pausedAt: z.string().nullable(),
		pauseStopRequestedAt: z.string().nullable(),
		inFlight: z.object({
			l2Transactions: z.number().int(),
			topups: z.number().int(),
			withdrawals: z.number().int(),
		}),
		nodes: z.array(z.object({ nodeId: z.string(), state: z.string().nullable(), error: z.string().nullable() })),
	})
	.openapi('HydraHostPauseState');

export const hydraHostPauseStateInput = z.object({ id: z.string() });

export const pauseHydraHostInput = z.object({
	id: z.string(),
	force: z
		.boolean()
		.default(false)
		.describe('Stop the nodes now, without waiting for in-flight work. That work then waits for Resume.'),
});

export const resumeHydraHostInput = z.object({ id: z.string() });

export const hydraHostPauseStateGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: hydraHostPauseStateInput,
	output: hydraHostPauseStateSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof hydraHostPauseStateInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, await readHydraHostNetwork(input.id));
		return getHydraHostPauseState(input.id);
	},
});

export const pauseHydraHostPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: pauseHydraHostInput,
	output: hydraHostPauseStateSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof pauseHydraHostInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, await readHydraHostNetwork(input.id));
		return pauseHydraHost(input.id, { force: input.force });
	},
});

export const resumeHydraHostPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: resumeHydraHostInput,
	output: hydraHostPauseStateSchema,
	handler: async ({ input, ctx }: { input: z.infer<typeof resumeHydraHostInput>; ctx: AuthContext }) => {
		await checkIsAllowedNetworkOrThrowUnauthorized(ctx.networkLimit, await readHydraHostNetwork(input.id));
		return resumeHydraHost(input.id);
	},
});
