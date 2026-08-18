// Colocated OpenAPI docs for the Hydra route area. When you add or change a Hydra
// endpoint, update THIS file in the same PR — CI regenerates openapi-docs.json and
// fails on drift. All Hydra endpoints require admin access.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	getHeadSchemaInput,
	getHeadSchemaOutput,
	updateHeadSchemaInput,
	updateHeadSchemaOutput,
	headBalanceSchemaInput,
	headBalanceSchemaOutput,
	listHeadErrorsSchemaInput,
	listHeadErrorsSchemaOutput,
	clearHeadErrorsSchemaInput,
	clearHeadErrorsSchemaOutput,
} from '@/routes/api/hydra/head';
import { lifecycleInput, lifecycleOutput, commitInput, commitOutput } from '@/routes/api/hydra/head/lifecycle';
import { closeHeadInput } from '@/routes/api/hydra/head/settlement';
import {
	topupInput,
	topupOutput,
	listTopupsInput,
	listTopupsOutput,
	recoverTopupInput,
	recoverTopupOutput,
} from '@/routes/api/hydra/head/topup';
import { headConnectionSchemaInput, headConnectionSchemaOutput } from '@/routes/api/hydra/head/observability';
import {
	withdrawInput,
	withdrawOutput,
	listWithdrawalsInput,
	listWithdrawalsOutput,
} from '@/routes/api/hydra/head/withdraw';
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
	fundParticipantNodeInput,
	fundParticipantNodeOutput,
	participantFundingSchemaInput,
	participantFundingSchemaOutput,
	withdrawParticipantNodeInput,
	withdrawParticipantNodeOutput,
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
			200: successResponse('Candidate wallets', listWalletBaseSchemaOutput, { wallets: [] }),
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
	// `close` is registered on its own below: it takes an extra acknowledgement
	// field the other two do not, and documenting it from this loop published a
	// body that could never close a head holding escrows.
	for (const action of ['init', 'fanout'] as const) {
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
		path: '/hydra/head/close',
		summary: 'Run the Hydra head close lifecycle action. (admin access required)',
		description:
			'Submits the close transaction for the head through the local Hydra node. Refused while the head still holds escrows or unconfirmed L2 work unless `acknowledgeActiveEscrows` is set, which accepts that those escrows move to L1 and must be collected there.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(closeHeadInput, { headId: HEAD_ID }) },
		responses: {
			200: successResponse('Head close result', lifecycleOutput, { headId: HEAD_ID, status: 'Closed' }),
			...unauthorized,
			...notFound,
			409: { description: 'Head is not in a state that permits close, or still holds active escrows' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/commit',
		summary: 'Commit the local participant funds into the head. (admin access required)',
		description:
			"Funds the head from the local participant's own L1 wallet UTxOs: builds and validates the node's commit draft, signs it, and submits it to L1.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(commitInput, { headId: HEAD_ID, lovelace: '10000000' }) },
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
			"Repeatable incremental commit into an already-Open head, reusing the same draft/validate/sign safety path as the initial commit. Each top-up is its own L1 deposit. With `exactAmount`, that amount is first carved into its own L1 UTxO and only that UTxO is deposited, so everything else in the wallet — an agent's registry NFT included — stays on L1; this is the way to top up from a mixed wallet. Without it, Hydra commits WHOLE UTxOs, so every wallet UTxO matching `assetFilter`/`assetUnit` goes into the head.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(topupInput, { headId: HEAD_ID, assetFilter: 'ada-only', exactAmount: '50000000' }) },
		responses: {
			// The endpoint answers as soon as the deposit is reserved; everything
			// about its progress is read from GET /hydra/head/topup afterwards.
			200: successResponse('Top-up accepted', topupOutput, { headId: HEAD_ID, accepted: true }),
			...unauthorized,
			...notFound,
			// Everything the deposit itself can get wrong is reported against the
			// top-up row and the head's errors, because it is built and submitted
			// after this answers. These three are decided before that.
			400: { description: 'Head has no local participant, or `exactAmount` is below the minimum a UTxO can hold' },
			409: { description: 'Head not open, disabled, not yet identified on chain, or its node is still catching up' },
			502: { description: 'No live connection to the head' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/withdraw',
		summary: 'Withdraw funds from an open head back to L1. (admin access required)',
		description:
			"Incremental decommit out of an already-Open head, without closing it. Withdraws the local participant's in-head funds to their own L1 address. A decommit removes every output of its transaction from the head, so an exact `lovelace` amount is first split off inside the head — free, and about a second — while omitting it withdraws whole UTxOs. One whole UTxO is held back as collateral so the wallet can still spend escrows inside the head — the smallest it holds worth at least 5 ADA, so the amount withheld is often more than that; `drain` takes it too, for winding a head down. Returns as soon as the request is accepted: the head must then sign a snapshot removing the funds before its node posts the L1 payout.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(withdrawInput, { headId: HEAD_ID, lovelace: '10000000', drain: false }) },
		responses: {
			200: successResponse('Withdrawal accepted', withdrawOutput, { headId: HEAD_ID, accepted: true }),
			...unauthorized,
			...notFound,
			400: { description: 'No eligible in-head funds, or less is eligible than was requested' },
			409: { description: 'Head not open, or a withdrawal from it is already in progress' },
			502: { description: 'The node rejected the withdrawal request' },
		},
	});
	registry.registerPath({
		method: 'get',
		path: '/hydra/head/withdraw',
		summary: 'List withdrawals from a head. (admin access required)',
		description:
			'Withdrawals out of this head, newest first. `approvedAt` is the point of no return: the head has signed the removal and the funds have left it, whether or not L1 has them yet. `finalizedAt` is when they became spendable on L1.',
		tags: TAG,
		security: secured,
		request: { query: listWithdrawalsInput },
		responses: {
			200: successResponse('Withdrawals', listWithdrawalsOutput, {
				withdrawals: [
					{
						id: 'cuid_v2_auto_generated',
						createdAt: '1970-01-01T00:00:00.000Z',
						updatedAt: '1970-01-01T00:00:00.000Z',
						status: 'Approved',
						splitTxId: 'b'.repeat(64),
						decommitTxId: 'a'.repeat(64),
						l1TxId: null,
						requestedLovelace: '10000000',
						requestedAssets: {},
						settledLovelace: null,
						settledAssets: null,
						destinationAddress: 'addr_test1...',
						failureReason: null,
						approvedAt: '1970-01-01T00:00:00.000Z',
						finalizedAt: null,
					},
				],
			}),
			...unauthorized,
			...notFound,
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
				unbackedLovelace: '0',
				hasUnbackedUtxos: false,
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
		path: '/hydra/head/topup',
		summary: 'List the deposits made into a head. (admin access required)',
		description:
			'Every top-up of this head, newest first, with the status of its L1 deposit. This is where a top-up is followed after POST /hydra/head/topup returns.',
		tags: TAG,
		security: secured,
		request: { query: listTopupsInput },
		responses: {
			200: successResponse('Head top-ups', listTopupsOutput, { topups: [] }),
			...unauthorized,
			...notFound,
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/topup/recover',
		summary: 'Recover a deposit the head never absorbed. (admin access required)',
		description:
			'A hydra-node only considers a deposit while it is inside its window, so a deposit can confirm on L1 and never reach the head. This asks the node to return it to the wallet it came from; it is refused before the deposit deadline has passed.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(recoverTopupInput, { topupId: 'cuid_v2_auto_generated' }) },
		responses: {
			200: successResponse('Recovery request', recoverTopupOutput, {
				depositTxHash: 'a'.repeat(64),
				requested: true,
				reason: null,
			}),
			...unauthorized,
			...notFound,
			409: { description: 'The deposit is not recoverable yet, or has already been absorbed or recovered' },
		},
	});
	registry.registerPath({
		method: 'get',
		path: '/hydra/head/connection',
		summary: "Read the state of this service's connection to the head's node. (admin access required)",
		description:
			'Whether a verified live session exists for this head, and what the node last reported. The first thing to read when a head is Open but L2 operations are failing.',
		tags: TAG,
		security: secured,
		request: { query: headConnectionSchemaInput },
		responses: {
			200: successResponse('Head connection', headConnectionSchemaOutput, { headId: HEAD_ID }),
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
	registry.registerPath({
		method: 'delete',
		path: '/hydra/head/errors',
		summary: 'Clear the recorded errors for a head. (admin access required)',
		description:
			'Acknowledges the errors recorded against a head. It changes nothing about the head itself — it only clears what the operator has already read.',
		tags: TAG,
		security: secured,
		// Body, not query: `src/app.ts` sets `delete: ['body', 'params']`, so a
		// DELETE handler never sees query at all. Documenting these as query
		// endpoints produced a client that could only ever get a 400 back.
		request: { body: jsonBody(clearHeadErrorsSchemaInput, { headId: HEAD_ID }) },
		responses: {
			200: successResponse('Cleared head errors', clearHeadErrorsSchemaOutput, { cleared: 0 }),
			...unauthorized,
			...notFound,
		},
	});

	// ---- participant: node fuel ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/participant/local/fund',
		summary: "Read a node's own balance and funding history. (admin access required)",
		description:
			"A hydra-node posts its head's L1 transactions from a Cardano key of its own, so it needs ADA that is not the head's. This reports what it holds and what has been sent to it.",
		tags: TAG,
		security: secured,
		request: { query: participantFundingSchemaInput },
		responses: {
			200: successResponse('Node funding', participantFundingSchemaOutput, { id: 'cuid_v2_auto_generated' }),
			...unauthorized,
			...notFound,
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/participant/local/fund',
		summary: "Send ADA to a node's own Cardano key. (admin access required)",
		description:
			'Tops the node up now rather than waiting for the funding cycle. Without this balance the node cannot post an Init, a Close or a Fanout.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(fundParticipantNodeInput, { id: 'cuid_v2_auto_generated' }) },
		responses: {
			200: successResponse('Node funding result', fundParticipantNodeOutput, { id: 'cuid_v2_auto_generated' }),
			...unauthorized,
			...notFound,
			409: { description: 'The funding wallet is busy, or the node does not need funds' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/participant/local/withdraw',
		summary: 'Sweep what a node did not spend back to its wallet. (admin access required)',
		description:
			"Returns the node's remaining ADA once its head is final. Refused while the head is still live or an invite still holds the node, because the node would need those funds.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(withdrawParticipantNodeInput, { id: 'cuid_v2_auto_generated' }) },
		responses: {
			200: successResponse('Node sweep result', withdrawParticipantNodeOutput, { id: 'cuid_v2_auto_generated' }),
			...unauthorized,
			...notFound,
			409: { description: 'The node is still needed, so its funds are kept' },
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
		request: { body: jsonBody(deleteHydraLowBalanceRuleSchemaInput, { id: 'cuid_v2_auto_generated' }) },
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
