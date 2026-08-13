/**
 * Read-only views of a head: its recorded errors, whether it is reachable, and
 * what the local participant holds inside it.
 *
 * Split from the head route module because none of it participates in the
 * lifecycle. These endpoints answer "what is going on", take no lock, change no
 * state, and depend on nothing else in that file — which is what made them the
 * safe first cut when it went past the 750-line limit.
 */

import { HydraErrorType, HydraHeadStatus } from '@/generated/prisma/client';
import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import { z } from '@masumi/payment-core/zod';

import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { getOwnInHeadBalance } from '@/services/hydra-connection-manager/hydra-head-balance';
import { readParticipantNodeState } from '@/services/hydra-host/node-state';
import { readHeadParamDrift } from '@/services/hydra-host/param-drift';
import { countHydraHeadActiveWork, hasActiveWork } from '@/utils/hydra/active-work';
import { describeCloseWithActiveWork } from '@/utils/hydra/close-with-active-work';
import { describeL2FundingBlock } from '@/utils/hydra/l2-funding-block';

// --- GET errors ---

export const headErrorSchema = z.object({
	id: z.string(),
	createdAt: z.date(),
	errorType: z.nativeEnum(HydraErrorType),
	errorMessage: z.string(),
	headStatus: z.nativeEnum(HydraHeadStatus),
	clientInput: z.string().nullable(),
	txHash: z.string().nullable(),
	errorAt: z.date(),
});

export const listHeadErrorsSchemaInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
	cursorId: z.string().optional().describe('Cursor ID for pagination'),
	limit: z.coerce.number().min(1).max(100).default(25).describe('Number of results'),
});

export const listHeadErrorsSchemaOutput = z.object({
	errors: z.array(headErrorSchema),
});

export const listHeadErrorsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: listHeadErrorsSchemaInput,
	output: listHeadErrorsSchemaOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId } });
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}

		const errors = await prisma.hydraHeadError.findMany({
			where: { hydraHeadId: input.headId },
			orderBy: { errorAt: 'desc' },
			take: input.limit,
			cursor: input.cursorId ? { id: input.cursorId } : undefined,
		});

		return { errors };
	},
});

// --- DELETE: clear a head's recorded errors ---

export const clearHeadErrorsSchemaInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

export const clearHeadErrorsSchemaOutput = z.object({ cleared: z.number() });

/**
 * Forget a head's errors.
 *
 * They are a log, not state: a failed Init that later succeeded leaves entries
 * behind that describe a problem which no longer exists, and an operator who
 * has read and acted on them has no way to stop the head being flagged. Nothing
 * downstream reads these rows — the head's own status is the source of truth —
 * so clearing them changes what is displayed and nothing else.
 */
export const clearHeadErrorsDelete = adminAuthenticatedEndpointFactory.build({
	method: 'delete',
	input: clearHeadErrorsSchemaInput,
	output: clearHeadErrorsSchemaOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({ where: { id: input.headId } });
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}
		const { count } = await prisma.hydraHeadError.deleteMany({ where: { hydraHeadId: input.headId } });
		return { cleared: count };
	},
});

// --- GET: is this head reachable right now? ---

export const headConnectionSchemaInput = z.object({ headId: z.string().min(1) });

export const headConnectionSchemaOutput = z.object({
	headId: z.string(),
	/** True when this service holds a live authenticated session to the head's node. */
	connected: z.boolean(),
	nodeState: z.string(),
	isReady: z.boolean(),
	peerConnected: z
		.boolean()
		.nullable()
		.describe(
			"Whether this node is in its Hydra cluster, which for a two-party head means the counterparty's node is up and reachable. Null until the node reports either way. Not a statement about their chain sync.",
		),
	reason: z.string().nullable(),
	/**
	 * Ways the head's own ledger no longer matches the chain it settles on.
	 *
	 * Empty in the normal case. A head's ledger is frozen at initialisation, so
	 * a chain that moves afterwards can leave the head creating outputs L1 will
	 * refuse to accept back at fanout — and value cannot be added to an output
	 * on its way out. Surfaced per head because the decision it drives is per
	 * head: close before the gap grows.
	 */
	paramDrift: z
		.array(
			z.object({
				parameter: z.string(),
				head: z.number(),
				chain: z.number(),
				blocksFanout: z.boolean(),
			}),
		)
		.describe('Empty when the head ledger matches the chain.'),
	/**
	 * Why this node cannot act inside the head, though the head itself is fine.
	 *
	 * Null in the normal case. Every L2 action this side initiates is a Plutus
	 * spend, which needs one of this wallet's own in-head UTxOs for collateral —
	 * so a participant with none can lock, submit and collect nothing, however
	 * healthy the head and the counterparty are. The services retry rather than
	 * park, which is right, but it left the operator with a request that stayed
	 * accepted and pending with no stated reason.
	 */
	l2Blocked: z.string().nullable(),
	/**
	 * What closing this head right now would cost, or null when it holds nothing.
	 *
	 * The close endpoint refuses an unacknowledged close while a head still holds
	 * escrows, and the refusal message is the explanation. Reported here so the
	 * confirmation can carry it before the operator commits, instead of the
	 * operator meeting it as a failure afterwards. Same wording, same counts.
	 */
	closeWithActiveWork: z.string().nullable().describe('Null when closing costs nothing beyond the close itself.'),
	checkedAt: z.string(),
});

/**
 * The close prompt for this head, or null when there is nothing to prompt about.
 *
 * Only Open heads can be closed, so anything else is not a question the operator
 * is being asked. Reading it costs two counts, which is why it is not attached
 * to the head list.
 */
async function readCloseWithActiveWork(
	headId: string,
	status: HydraHeadStatus,
	contestationPeriod: bigint,
): Promise<string | null> {
	if (status !== HydraHeadStatus.Open) return null;
	const activeWork = await countHydraHeadActiveWork(prisma, headId);
	if (!hasActiveWork(activeWork)) return null;
	return describeCloseWithActiveWork(contestationPeriod, activeWork.pendingL2Transactions, activeWork.activeEscrows);
}

/**
 * Whether this node holds enough inside the head to build a transaction there.
 *
 * The decision itself lives in `@/utils/hydra/l2-funding-block`; this only
 * fetches what it needs. Reading the balance can fail, and this is decoration
 * on a readiness answer — the operator still needs the rest of it, so a failed
 * snapshot read must not take the endpoint down with it.
 */
async function readL2FundingBlock(headId: string, status: HydraHeadStatus): Promise<string | null> {
	if (status !== HydraHeadStatus.Open) return null;
	try {
		return describeL2FundingBlock(status, await getOwnInHeadBalance(headId));
	} catch {
		return null;
	}
}

/**
 * Whether anything can be done with this head at this moment.
 *
 * Two different things have to be true and were both invisible: the node has to
 * be running and synced, and this service has to hold a live session to it. A
 * head can be perfectly valid on chain while neither holds, and the only
 * evidence was an action failing minutes later with a timeout.
 *
 * Read on demand rather than polled, because it costs a round trip to the Host
 * and an operator asks it when something looks stuck.
 */
export const getHeadConnectionGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: headConnectionSchemaInput,
	output: headConnectionSchemaOutput,
	handler: async ({ input }) => {
		const head = await prisma.hydraHead.findUnique({
			where: { id: input.headId },
			include: { LocalParticipant: { select: { id: true } } },
		});
		if (!head) {
			throw createHttpError(404, 'Hydra head not found');
		}

		const node = head.LocalParticipant
			? await readParticipantNodeState(head.LocalParticipant.id)
			: { state: 'Unknown', isReady: false, reason: 'This head has no local participant.' };

		// What the counterparty's node is doing is not directly observable: there
		// is no token for it and the Exchange Plane is one-shot. This is the one
		// signal that carries: under Hydra's etcd network layer, being connected
		// means this node is in the majority cluster, which for a two-party head
		// means the other node is up and reachable. It does NOT mean the other
		// node has finished syncing the chain, so it is reported rather than
		// gated on.
		const manager = getHydraConnectionManager();
		const peerLink = manager.getNode(head.id)?.networkConnected ?? null;

		return {
			headId: head.id,
			connected: manager.isConnected(head.id),
			nodeState: node.state,
			isReady: node.isReady,
			reason: node.reason,
			peerConnected: peerLink,
			paramDrift: await readHeadParamDrift(head.id),
			l2Blocked: await readL2FundingBlock(head.id, head.status),
			closeWithActiveWork: await readCloseWithActiveWork(head.id, head.status, head.contestationPeriod),
			checkedAt: new Date().toISOString(),
		};
	},
});

// --- GET: own in-head balance (local participant only) ---

export const headBalanceSchemaInput = z.object({
	headId: z.string().min(1).describe('ID of the HydraHead'),
});

export const headBalanceSchemaOutput = z.object({
	hydraHeadId: z.string(),
	address: z.string().describe('The local participant wallet address whose in-head funds are reported'),
	connected: z
		.boolean()
		.describe('True when a live head snapshot was read; false when the head has no active connection'),
	utxoCount: z.number().describe('Number of in-head UTxOs held by the local address'),
	unbackedLovelace: z
		.string()
		.describe(
			'Lovelace the head reports holding whose L1 deposit was recovered to the wallet. hydra-node can keep a deposit in its L2 ledger that was never really absorbed, so the balance above reads high by this much and a close would fail on the overhead it implies.',
		),
	hasUnbackedUtxos: z.boolean().describe('True when any reported UTxO is unbacked, so the balance is optimistic'),
	balance: z
		.array(
			z.object({
				unit: z.string().describe('Empty string for ADA/lovelace; otherwise policyId+assetName hex'),
				quantity: z.string().describe('Aggregate quantity across the local address in-head UTxOs'),
			}),
		)
		.describe("This node's own funds currently inside the head (ADA + native tokens). Excludes the counterparty."),
});

export const getHeadBalanceGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: headBalanceSchemaInput,
	output: headBalanceSchemaOutput,
	handler: async ({ input }) => {
		const balance = await getOwnInHeadBalance(input.headId);
		if (balance == null) {
			throw createHttpError(404, 'Hydra head or its local participant wallet not found');
		}
		return balance;
	},
});
