// OpenAPI docs for moving funds out of an open head, and merging what stays in it.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	withdrawInput,
	withdrawOutput,
	listWithdrawalsInput,
	listWithdrawalsOutput,
} from '@/routes/api/hydra/head/withdraw';
import { consolidateInput, consolidateOutput } from '@/routes/api/hydra/head/consolidate';

const HEAD_ID = 'cuid_v2_auto_generated';
const TAG = ['hydra'];
const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});

export function registerHydraWithdrawPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const unauthorized = { 401: { description: 'Unauthorized' } } as const;
	const notFound = { 404: { description: 'Hydra head not found' } } as const;
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
			// What the withdrawal itself gets wrong — nothing eligible, less eligible
			// than was asked for, a node that refuses the request — is reported
			// against the withdrawal row, because it is decided after this answers.
			// These are the refusals a caller can actually receive.
			400: {
				description:
					'Asked for lovelace and a native asset in one request, gave only one half of the asset pair, or the head has no local participant',
			},
			409: {
				description: 'Head not open, disabled, not yet identified on chain, or its node is still catching up',
			},
			502: { description: 'No live connection to the head' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/consolidate',
		summary: "Merge the local wallet's in-head UTxOs. (admin access required)",
		description:
			"An in-head self-send that spends every plain UTxO at the local participant's address (datum or not) and produces one UTxO carrying everything, plus a pure-ADA collateral UTxO of 5 ADA when the funds allow it. Free, and nothing leaves the head. UTxOs still being folded in by a deposit, or carrying a reference script, are left alone. One round spends at most 100 UTxOs; `remainingCount` above zero means call again. Waits for the head to confirm.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(consolidateInput, { headId: HEAD_ID }) },
		responses: {
			200: successResponse('Consolidated', consolidateOutput, {
				headId: HEAD_ID,
				txId: 'c'.repeat(64),
				inputCount: 63,
				outputCount: 2,
				remainingCount: 0,
			}),
			...unauthorized,
			...notFound,
			400: { description: 'Head has no local participant, or the wallet has nothing to consolidate' },
			409: {
				description:
					'Head not open or disabled, its node is still catching up, a withdrawal is in progress or still settling, or the wallet is busy',
			},
			502: { description: 'No live connection to the head' },
			504: { description: 'The head accepted the self-send but did not confirm it in time' },
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
}
