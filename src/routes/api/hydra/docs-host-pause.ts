// OpenAPI docs for pausing a Hydra Host for maintenance and resuming it.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	hydraHostPauseStateInput,
	hydraHostPauseStateSchema,
	pauseHydraHostInput,
	resumeHydraHostInput,
} from '@/routes/api/hydra/host/pause';

const HOST_ID = 'cuid_v2_auto_generated';
const TAG = ['hydra'];
const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});
const PAUSED_EXAMPLE = {
	hostId: HOST_ID,
	phase: 'Draining',
	pausedAt: '2026-10-17T10:00:00.000Z',
	pauseStopRequestedAt: null,
	inFlight: { l2Transactions: 1, topups: 0, withdrawals: 0, closingHeads: 0 },
	nodes: [{ nodeId: 'node-1', state: 'Running', error: null }],
};

export function registerHydraHostPausePaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const unauthorized = { 401: { description: 'Unauthorized' } } as const;
	const notFound = { 404: { description: 'Hydra host not found' } } as const;

	registry.registerPath({
		method: 'get',
		path: '/hydra/host/pause',
		summary: 'Read the pause state of a Hydra Host. (admin access required)',
		description:
			'Reports the pause phase, the in-flight work that still holds the nodes, and the state each node reports.',
		tags: TAG,
		security: secured,
		request: { query: hydraHostPauseStateInput },
		responses: {
			200: successResponse('Pause state', hydraHostPauseStateSchema, PAUSED_EXAMPLE),
			...unauthorized,
			...notFound,
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/hydra/host/pause',
		summary: 'Pause a Hydra Host for maintenance. (admin access required)',
		description:
			'Refuses new work on every head of this Host at once: L2 locks, top-ups, withdrawals, consolidation, init and commit. The service stops the nodes once in-flight work has settled and no head on the Host is closing or in its dispute window, or at once with `force`. The pause survives restarts of this service and of the Host. Keep it short: a stopped node cannot contest a close, and reserved L2 actions are parked for manual action after a little over three hours.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(pauseHydraHostInput, { id: HOST_ID, force: false }) },
		responses: {
			200: successResponse('Pause accepted', hydraHostPauseStateSchema, PAUSED_EXAMPLE),
			409: {
				description:
					'Host has no admin token, so its nodes cannot be stopped; or a forced pause found another pause action running. In the second case the pause is still recorded and drains; retry the force.',
			},
			...unauthorized,
			...notFound,
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/hydra/host/resume',
		summary: 'Resume a paused Hydra Host. (admin access required)',
		description:
			'Starts the nodes the pause stopped, then accepts new work again. If a node does not start, the Host stays paused and the call can be repeated.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(resumeHydraHostInput, { id: HOST_ID }) },
		responses: {
			200: successResponse('Resumed', hydraHostPauseStateSchema, {
				...PAUSED_EXAMPLE,
				phase: 'Active',
				pausedAt: null,
				inFlight: { l2Transactions: 0, topups: 0, withdrawals: 0, closingHeads: 0 },
			}),
			409: { description: 'Host has no admin token, or another pause action is running' },
			502: { description: 'A node did not start; the Host stays paused' },
			...unauthorized,
			...notFound,
		},
	});
}
