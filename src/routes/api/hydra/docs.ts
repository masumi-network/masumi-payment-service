// Colocated OpenAPI docs for the Hydra route area. When you add or change a Hydra
// endpoint, update THIS file in the same PR — CI regenerates openapi-docs.json and
// fails on drift. All Hydra endpoints require admin access.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	getHeadSchemaInput,
	getHeadSchemaOutput,
	updateHeadSchemaInput,
	updateHeadSchemaOutput,
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
import { listHeadTransactionsInput, listHeadTransactionsOutput } from '@/routes/api/hydra/head/transactions';
import {
	listHydraLowBalanceRulesSchemaInput,
	listHydraLowBalanceRulesSchemaOutput,
	setHydraLowBalanceRuleSchemaInput,
	setHydraLowBalanceRuleSchemaOutput,
	deleteHydraLowBalanceRuleSchemaInput,
	deleteHydraLowBalanceRuleSchemaOutput,
} from '@/routes/api/hydra/low-balance';
import {
	getLocalParticipantInput,
	getLocalParticipantOutput,
	revealParticipantKeysInput,
	revealParticipantKeysOutput,
	deleteLocalParticipantInput,
	deleteLocalParticipantOutput,
	getRemoteParticipantInput,
	getRemoteParticipantOutput,
	deleteRemoteParticipantInput,
	deleteRemoteParticipantOutput,
} from '@/routes/api/hydra/participant';
import {
	getRelationSchemaInput,
	getRelationSchemaOutput,
	deleteRelationSchemaInput,
	deleteRelationSchemaOutput,
} from '@/routes/api/hydra/relation';
import {
	listWalletBaseSchemaInput,
	listWalletBaseSchemaOutput,
	ensureWalletBaseSchemaInput,
	ensureWalletBaseSchemaOutput,
} from '@/routes/api/hydra/wallet-base';
import {
	checkHydraHostSchemaInput,
	deleteHydraHostSchemaInput,
	deleteHydraHostSchemaOutput,
	hydraHostSchema,
	listHydraHostsSchemaInput,
	listHydraHostsSchemaOutput,
	registerHydraHostSchemaInput,
	updateHydraHostSchemaInput,
} from '@/routes/api/hydra/host';
import {
	createInviteSchemaInput,
	createInviteSchemaOutput,
	deleteInviteSchemaInput,
	deleteInviteSchemaOutput,
	getInviteSchemaInput,
	getInviteSchemaOutput,
	previewInviteSchemaInput,
	previewInviteSchemaOutput,
	redeemInviteSchemaInput,
	redeemInviteSchemaOutput,
} from '@/routes/api/hydra/invite';

const HEAD_ID = 'cuid_v2_auto_generated';
const TAG = ['hydra'];

const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});

export function registerHydraPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const unauthorized = { 401: { description: 'Unauthorized' } } as const;
	const notFound = { 404: { description: 'Hydra head not found' } } as const;

	// ---- invite ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/invite',
		summary: 'List head invites. (admin access required)',
		description:
			'Invites this service has issued or redeemed. An issued invite holds a provisioned node and a peer port until it is redeemed, revoked or expires.',
		tags: TAG,
		security: secured,
		request: { query: getInviteSchemaInput },
		responses: { 200: successResponse('Head invites', getInviteSchemaOutput, { invites: [] }), ...unauthorized },
	});

	registry.registerPath({
		method: 'post',
		path: '/hydra/invite',
		summary: 'Mint a head invite. (admin access required)',
		description:
			"Provisions a node on a Hydra Host and signs its full public material with the given wallet, producing a code to hand a counterparty out of band. The node and its peer port are reserved from this moment and cannot be re-pointed, because --peer is fixed at boot — so an invite that is never redeemed must be revoked or left to expire. Redeeming it is what supplies the counterparty's material and lets the node start.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(createInviteSchemaInput, {}) },
		responses: {
			200: successResponse('Invite minted', createInviteSchemaOutput, {}),
			409: { description: 'No usable Hydra Host, or the host has no admin token' },
			...unauthorized,
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/hydra/invite/preview',
		summary: 'Inspect an invite without acting on it. (admin access required)',
		description:
			'Decodes an invite code and reports whether its signature matches the wallet it claims to be from. Nothing is provisioned and no counterparty is contacted, so this is safe to call on an invite of unknown provenance. A false `signatureValid` is reported rather than thrown, because an operator looking at a forged invite is better served by being told so.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(previewInviteSchemaInput, {}) },
		responses: {
			200: successResponse('Invite contents', previewInviteSchemaOutput, {}),
			400: { description: 'Not a well-formed invite code' },
			...unauthorized,
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/hydra/invite/redeem',
		summary: 'Redeem a counterparty invite. (admin access required)',
		description:
			"Verifies the issuer's signature, provisions our own node, sends our material to the issuer's Exchange Plane and records the resulting relation and head. Spends a node and a peer port, and tells the counterparty we are ready, so it is deliberate rather than automatic.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(redeemInviteSchemaInput, {}) },
		responses: {
			200: successResponse('Invite redeemed', redeemInviteSchemaOutput, {}),
			409: { description: 'Wrong network, already redeemed, expired, or our own invite' },
			502: { description: "The counterparty's exchange plane refused or could not be reached" },
			...unauthorized,
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/hydra/invite',
		summary: 'Revoke an unredeemed invite. (admin access required)',
		description:
			'Stops the Host honouring the nonce and releases the node and peer port it reserved. Refused once redeemed: by then the reservation is a running node with a peer, and removing that is closing a head.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(deleteInviteSchemaInput, {}) },
		responses: {
			200: successResponse('Invite revoked', deleteInviteSchemaOutput, {}),
			409: { description: 'Already redeemed, or not an invite we issued' },
			...unauthorized,
		},
	});

	// ---- host ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/host',
		summary: 'List registered Hydra Hosts. (admin access required)',
		description:
			'Lists the Hydra Host deployments that can run hydra-node processes for this service. Tokens are never returned; `hasAdminToken` reports whether a Host can be provisioned on.',
		tags: TAG,
		security: secured,
		request: { query: listHydraHostsSchemaInput },
		responses: {
			200: successResponse('Registered hosts', listHydraHostsSchemaOutput, undefined),
			...unauthorized,
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/hydra/host',
		summary: 'Register a Hydra Host. (admin access required)',
		description:
			'Registers a Hydra Host control plane. The user token grants runtime access to the proxied node API; the optional admin token additionally allows provisioning nodes on this Host. Both are stored encrypted and never returned.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(registerHydraHostSchemaInput, undefined) },
		responses: {
			200: successResponse('Registered host', hydraHostSchema, undefined),
			409: { description: 'A host for this network and base URL is already registered' },
			...unauthorized,
		},
	});

	registry.registerPath({
		method: 'patch',
		path: '/hydra/host',
		summary: 'Update a Hydra Host. (admin access required)',
		description:
			'Updates a Host label, status or tokens. Setting status to Draining keeps existing heads served while accepting no new placements, which matters because a head cannot be moved to another Host.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(updateHydraHostSchemaInput, undefined) },
		responses: {
			200: successResponse('Updated host', hydraHostSchema, undefined),
			404: { description: 'Hydra host not found' },
			...unauthorized,
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/hydra/host',
		summary: 'Remove a Hydra Host. (admin access required)',
		description:
			'Removes a Host registration. Refused while the Host still runs nodes, because their heads cannot be relocated.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(deleteHydraHostSchemaInput, undefined) },
		responses: {
			200: successResponse('Removed host', deleteHydraHostSchemaOutput, undefined),
			409: { description: 'Host still runs nodes' },
			404: { description: 'Hydra host not found' },
			...unauthorized,
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/hydra/host/check',
		summary: 'Probe a Hydra Host and record its capabilities. (admin access required)',
		description:
			'Asks the Host which hydra-node version, script catalogue and ledger parameters it runs, and records the answer. A failed probe marks the Host Unreachable, which stops new placements without disturbing the heads already on it.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(checkHydraHostSchemaInput, undefined) },
		responses: {
			200: successResponse('Host capabilities', hydraHostSchema, undefined),
			409: { description: 'Host has no admin token' },
			404: { description: 'Hydra host not found' },
			...unauthorized,
		},
	});

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
		path: '/hydra/head/transactions',
		summary: "List a Hydra head's transactions. (admin access required)",
		description:
			'Every transaction recorded against this head, newest first: L1 for on-chain and L2 for inside the head. The head record itself carries only the Init, Close and Fanout hashes.',
		tags: TAG,
		security: secured,
		request: { query: listHeadTransactionsInput },
		responses: {
			200: successResponse('Hydra head transactions', listHeadTransactionsOutput, { transactions: [] }),
			...unauthorized,
			...notFound,
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

	// ---- low-balance rules ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/low-balance',
		summary: 'List Hydra in-head low-balance rules. (admin access required)',
		description: "Lists low-balance monitoring rules for local participants' own in-head balances.",
		tags: TAG,
		security: secured,
		request: { query: listHydraLowBalanceRulesSchemaInput },
		responses: {
			200: successResponse('Hydra low-balance rules', listHydraLowBalanceRulesSchemaOutput, { rules: [] }),
			...unauthorized,
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/low-balance',
		summary: 'Create or update a Hydra in-head low-balance rule. (admin access required)',
		description:
			"Upserts a rule (keyed by participant + asset) that alerts when the participant's own in-head balance for the asset falls below the threshold, and optionally auto-tops-up from its assigned funding wallet.",
		tags: TAG,
		security: secured,
		request: {
			body: jsonBody(setHydraLowBalanceRuleSchemaInput, {
				hydraLocalParticipantId: HEAD_ID,
				assetUnit: 'lovelace',
				thresholdAmount: '50000000',
				enabled: true,
				topupEnabled: false,
			}),
		},
		responses: {
			200: successResponse('Upserted rule', setHydraLowBalanceRuleSchemaOutput, {
				rule: {
					id: HEAD_ID,
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
					hydraLocalParticipantId: HEAD_ID,
					assetUnit: 'lovelace',
					thresholdAmount: '50000000',
					enabled: true,
					topupEnabled: false,
					topupAmount: null,
					status: 'Unknown',
					lastKnownAmount: null,
					lastCheckedAt: null,
					lastAlertedAt: null,
				},
			}),
			...unauthorized,
			404: { description: 'Hydra local participant not found' },
		},
	});
	registry.registerPath({
		method: 'delete',
		path: '/hydra/low-balance',
		summary: 'Delete a Hydra in-head low-balance rule. (admin access required)',
		description: 'Removes a low-balance rule by id.',
		tags: TAG,
		security: secured,
		request: { query: deleteHydraLowBalanceRuleSchemaInput },
		responses: {
			200: successResponse('Deleted rule', deleteHydraLowBalanceRuleSchemaOutput, { id: HEAD_ID }),
			...unauthorized,
			404: { description: 'Hydra low-balance rule not found' },
		},
	});

	// ---- participant: local ----
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
		method: 'post',
		path: '/hydra/participant/local/keys',
		summary: "Back up a node's signing keys, once. (admin access required)",
		description:
			'Returns the node Hydra and Cardano signing keys a single time, then seals the path: every later call is refused. The keys are generated by the Hydra Host and disclosed by it once at provisioning, so this is the only way to take an off-site copy.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(revealParticipantKeysInput, { id: HEAD_ID }) },
		responses: {
			200: successResponse('Node signing keys', revealParticipantKeysOutput, { id: HEAD_ID }),
			...unauthorized,
			404: { description: 'Local participant not found' },
			409: { description: 'The keys have already been handed out once' },
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
