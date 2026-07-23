// Colocated OpenAPI docs for the Hydra route area. When you add or change a Hydra
// endpoint, update THIS file in the same PR — CI regenerates openapi-docs.json and
// fails on drift. All Hydra endpoints require admin access.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	getHeadSchemaInput,
	getHeadSchemaOutput,
	createHeadSchemaInput,
	createHeadSchemaOutput,
	updateHeadSchemaInput,
	updateHeadSchemaOutput,
	checkHeadNodeSchemaInput,
	checkHeadNodeSchemaOutput,
	lifecycleInput,
	lifecycleOutput,
	commitInput,
	commitOutput,
	headBalanceSchemaInput,
	headBalanceSchemaOutput,
	listHeadErrorsSchemaInput,
	listHeadErrorsSchemaOutput,
} from '@/routes/api/hydra/head';
import { topupInput, topupOutput } from '@/routes/api/hydra/head/topup';
import {
	createLocalParticipantInput,
	createLocalParticipantOutput,
	getLocalParticipantInput,
	getLocalParticipantOutput,
	deleteLocalParticipantInput,
	deleteLocalParticipantOutput,
	createRemoteParticipantInput,
	createRemoteParticipantOutput,
	getRemoteParticipantInput,
	getRemoteParticipantOutput,
	deleteRemoteParticipantInput,
	deleteRemoteParticipantOutput,
} from '@/routes/api/hydra/participant';
import {
	getRelationSchemaInput,
	getRelationSchemaOutput,
	createRelationSchemaInput,
	createRelationSchemaOutput,
	deleteRelationSchemaInput,
	deleteRelationSchemaOutput,
} from '@/routes/api/hydra/relation';
import {
	listWalletBaseSchemaInput,
	listWalletBaseSchemaOutput,
	ensureWalletBaseSchemaInput,
	ensureWalletBaseSchemaOutput,
} from '@/routes/api/hydra/wallet-base';

const HEAD_ID = 'cuid_v2_auto_generated';
const TAG = ['hydra'];

const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});

export function registerHydraPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const unauthorized = { 401: { description: 'Unauthorized' } } as const;
	const notFound = { 404: { description: 'Hydra head not found' } } as const;

	// ---- wallet-base ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/wallet-base',
		summary: 'List candidate wallets for Hydra participants. (admin access required)',
		description:
			'Lists the WalletBase entries eligible to back a Hydra participant, optionally filtered by network and payment source.',
		tags: TAG,
		security: secured,
		request: { query: listWalletBaseSchemaInput },
		responses: {
			200: successResponse('Candidate wallets', listWalletBaseSchemaOutput, { walletBases: [] }),
			...unauthorized,
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/wallet-base',
		summary: 'Ensure a WalletBase exists for a Hydra counterparty. (admin access required)',
		description:
			'Idempotently records a counterparty wallet (vkey + address) so it can be referenced as a remote Hydra participant.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(ensureWalletBaseSchemaInput, {}) },
		responses: {
			200: successResponse('WalletBase ensured', ensureWalletBaseSchemaOutput, {}),
			...unauthorized,
		},
	});

	// ---- relation ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/relation',
		summary: 'List Hydra relations. (admin access required)',
		description: 'Lists the local↔remote wallet pairings that Hydra heads are created from.',
		tags: TAG,
		security: secured,
		request: { query: getRelationSchemaInput },
		responses: { 200: successResponse('Hydra relations', getRelationSchemaOutput, { relations: [] }), ...unauthorized },
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/relation',
		summary: 'Create a Hydra relation. (admin access required)',
		description:
			'Pairs a local hot wallet with a remote counterparty wallet on a network; a head is later opened from this relation.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(createRelationSchemaInput, {}) },
		responses: {
			200: successResponse('Hydra relation created', createRelationSchemaOutput, {}),
			...unauthorized,
			409: { description: 'Relation already exists or conflicts with an existing head' },
		},
	});
	registry.registerPath({
		method: 'delete',
		path: '/hydra/relation',
		summary: 'Delete a Hydra relation. (admin access required)',
		description: 'Deletes a relation that has no active (non-final) head.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(deleteRelationSchemaInput, { id: HEAD_ID }) },
		responses: {
			200: successResponse('Hydra relation deleted', deleteRelationSchemaOutput, { id: HEAD_ID, deleted: true }),
			...unauthorized,
			409: { description: 'Relation still has an active head' },
		},
	});

	// ---- head: CRUD ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/head',
		summary: 'List or get Hydra heads. (admin access required)',
		description:
			'Lists Hydra heads with lifecycle status, participants and reconciliation state. Filter by id, relationId, status, or isEnabled.',
		tags: TAG,
		security: secured,
		request: { query: getHeadSchemaInput },
		responses: { 200: successResponse('Hydra heads', getHeadSchemaOutput, { heads: [] }), ...unauthorized },
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head',
		summary: 'Create a Hydra head from a relation. (admin access required)',
		description:
			'Binds a head to a relation with the given contestation period and pre-created local/remote participants. Does not open it — call init/commit next.',
		tags: TAG,
		security: secured,
		request: {
			body: jsonBody(createHeadSchemaInput, {
				hydraRelationId: HEAD_ID,
				localParticipantId: HEAD_ID,
				remoteParticipantIds: [HEAD_ID],
			}),
		},
		responses: {
			200: successResponse('Hydra head created', createHeadSchemaOutput, { id: HEAD_ID }),
			...unauthorized,
			404: { description: 'Relation or participant not found' },
		},
	});
	registry.registerPath({
		method: 'patch',
		path: '/hydra/head',
		summary: 'Enable or disable a Hydra head. (admin access required)',
		description:
			'Enabling re-verifies the head/participants/InitTx on L1 before re-admitting it; disabling quarantines it (drops its InitTx admission).',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(updateHeadSchemaInput, { id: HEAD_ID, isEnabled: true }) },
		responses: {
			200: successResponse('Hydra head updated', updateHeadSchemaOutput, { id: HEAD_ID }),
			...unauthorized,
			...notFound,
			502: { description: 'On-chain verification failed' },
			503: { description: 'Independent L1 evidence not yet available' },
		},
	});

	// ---- head: lifecycle ----
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/check',
		summary: 'Probe the configured Hydra node reachability. (admin access required)',
		description:
			'Checks that the local participant Hydra node is reachable over its configured WebSocket/HTTP endpoints.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(checkHeadNodeSchemaInput, { headId: HEAD_ID }) },
		responses: {
			200: successResponse('Node reachability', checkHeadNodeSchemaOutput, { headId: HEAD_ID, reachable: true }),
			...unauthorized,
			...notFound,
		},
	});
	for (const action of ['init', 'close', 'fanout'] as const) {
		registry.registerPath({
			method: 'post',
			path: `/hydra/head/${action}`,
			summary: `Run the Hydra head ${action} lifecycle action. (admin access required)`,
			description: `Submits the ${action} transaction for the head through the local Hydra node.`,
			tags: TAG,
			security: secured,
			request: { body: jsonBody(lifecycleInput, { headId: HEAD_ID }) },
			responses: {
				200: successResponse(`Head ${action} result`, lifecycleOutput, { headId: HEAD_ID, status: 'Open' }),
				...unauthorized,
				...notFound,
				409: { description: `Head is not in a state that permits ${action}` },
			},
		});
	}
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/commit',
		summary: 'Commit the local participant funds into the head. (admin access required)',
		description:
			"Funds the head from the local participant's own L1 wallet UTxOs: builds and validates the node's commit draft, signs it, and submits it to L1.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(commitInput, { headId: HEAD_ID }) },
		responses: {
			200: successResponse('Commit result', commitOutput, { headId: HEAD_ID, committed: true, commitTxHash: null }),
			...unauthorized,
			...notFound,
			409: { description: 'Head not committable, or the local participant already committed' },
			502: { description: 'The node returned an unsafe or invalid commit draft' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/topup',
		summary: 'Top up additional funds into an open head. (admin access required)',
		description:
			"Repeatable incremental commit into an already-Open head. Commits more of the local participant's L1 wallet UTxOs (optionally filtered to ADA-only or a specific native-asset unit), reusing the same draft/validate/sign safety path as the initial commit. Each top-up is its own L1 deposit.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(topupInput, { headId: HEAD_ID, assetFilter: 'all' }) },
		responses: {
			200: successResponse('Top-up result', topupOutput, {
				headId: HEAD_ID,
				topupId: 'cuid_v2_auto_generated',
				depositTxHash: 'a'.repeat(64),
				confirmed: false,
				committedLovelace: '10000000',
				committedAssets: {},
			}),
			...unauthorized,
			...notFound,
			400: { description: 'No plain wallet UTxOs match the requested asset filter' },
			409: { description: 'Head not open, initial commit missing, or a prior top-up is still pending' },
			502: { description: 'The node returned an unsafe or invalid top-up draft' },
		},
	});
	registry.registerPath({
		method: 'get',
		path: '/hydra/head/balance',
		summary: "Read this node's own in-head balance. (admin access required)",
		description:
			"Reports the local participant's own funds currently inside the head (ADA + native tokens), aggregated per asset. Excludes the counterparty. Requires an open/connected head.",
		tags: TAG,
		security: secured,
		request: { query: headBalanceSchemaInput },
		responses: {
			200: successResponse('Own in-head balance', headBalanceSchemaOutput, {
				hydraHeadId: HEAD_ID,
				address: 'addr_test1...',
				connected: true,
				utxoCount: 1,
				balance: [{ unit: '', quantity: '10000000' }],
			}),
			...unauthorized,
			404: { description: 'Hydra head or its local participant wallet not found' },
		},
	});
	registry.registerPath({
		method: 'get',
		path: '/hydra/head/errors',
		summary: 'List recorded Hydra head errors. (admin access required)',
		description: 'Lists the most recent errors recorded for a head (lifecycle command failures, etc.).',
		tags: TAG,
		security: secured,
		request: { query: listHeadErrorsSchemaInput },
		responses: {
			200: successResponse('Hydra head errors', listHeadErrorsSchemaOutput, { errors: [] }),
			...unauthorized,
			...notFound,
		},
	});

	// ---- participant: local ----
	registry.registerPath({
		method: 'post',
		path: '/hydra/participant/local',
		summary: 'Create a local Hydra participant. (admin access required)',
		description:
			"Registers this server's participant: its funding hot wallet, Hydra signing key, node URLs, and (optionally) the node's dedicated Cardano vkey used as the on-chain participant identity.",
		tags: TAG,
		security: secured,
		request: {
			body: jsonBody(createLocalParticipantInput, {
				walletId: HEAD_ID,
				nodeUrl: 'ws://127.0.0.1:4001',
				nodeHttpUrl: 'http://127.0.0.1:4001',
				hydraSK: '5820...',
			}),
		},
		responses: {
			200: successResponse('Local participant created', createLocalParticipantOutput, {}),
			...unauthorized,
			404: { description: 'HotWallet not found' },
		},
	});
	registry.registerPath({
		method: 'get',
		path: '/hydra/participant/local',
		summary: 'List local Hydra participants. (admin access required)',
		description: "Lists this server's Hydra participants, optionally filtered by wallet or assignment state.",
		tags: TAG,
		security: secured,
		request: { query: getLocalParticipantInput },
		responses: {
			200: successResponse('Local participants', getLocalParticipantOutput, { participants: [] }),
			...unauthorized,
		},
	});
	registry.registerPath({
		method: 'delete',
		path: '/hydra/participant/local',
		summary: 'Delete a local Hydra participant. (admin access required)',
		description: 'Deletes an unassigned local participant, or one whose head is safely finalized/quiesced.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(deleteLocalParticipantInput, { id: HEAD_ID }) },
		responses: {
			200: successResponse('Local participant deleted', deleteLocalParticipantOutput, { id: HEAD_ID, deleted: true }),
			...unauthorized,
			404: { description: 'Local participant not found' },
		},
	});

	// ---- participant: remote ----
	registry.registerPath({
		method: 'post',
		path: '/hydra/participant/remote',
		summary: 'Create a remote Hydra participant. (admin access required)',
		description:
			"Registers the counterparty participant: its wallet, Hydra verification key, node URLs, and (optionally) the remote node's dedicated Cardano vkey.",
		tags: TAG,
		security: secured,
		request: {
			body: jsonBody(createRemoteParticipantInput, {
				walletId: HEAD_ID,
				nodeUrl: 'ws://127.0.0.1:4002',
				nodeHttpUrl: 'http://127.0.0.1:4002',
				hydraVK: '5820...',
			}),
		},
		responses: {
			200: successResponse('Remote participant created', createRemoteParticipantOutput, {}),
			...unauthorized,
			404: { description: 'WalletBase not found' },
		},
	});
	registry.registerPath({
		method: 'get',
		path: '/hydra/participant/remote',
		summary: 'List remote Hydra participants. (admin access required)',
		description: 'Lists counterparty participants, optionally filtered by wallet or assignment state.',
		tags: TAG,
		security: secured,
		request: { query: getRemoteParticipantInput },
		responses: {
			200: successResponse('Remote participants', getRemoteParticipantOutput, { participants: [] }),
			...unauthorized,
		},
	});
	registry.registerPath({
		method: 'delete',
		path: '/hydra/participant/remote',
		summary: 'Delete a remote Hydra participant. (admin access required)',
		description: 'Deletes an unassigned remote participant, or one whose head is safely finalized/quiesced.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(deleteRemoteParticipantInput, { id: HEAD_ID }) },
		responses: {
			200: successResponse('Remote participant deleted', deleteRemoteParticipantOutput, { id: HEAD_ID, deleted: true }),
			...unauthorized,
			404: { description: 'Remote participant not found' },
		},
	});
}
