import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { z } from '@/utils/zod-openapi';
import { prisma } from '@masumi/payment-core/db';
import { Prisma } from '@/generated/prisma/client';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import createHttpError from 'http-errors';
import { fundHydraNodeNow, readNodeFundingState, readNodeFundingPolicy } from '@/services/hydra-node-funding/service';
import { readParticipantNodeState } from '@/services/hydra-host/node-state';

// --- POST: fund this node's Cardano key ---

export const fundParticipantNodeInput = z.object({
	id: z.string().min(1).describe('Local participant whose node should be funded'),
});

export const fundParticipantNodeOutput = z.object({
	address: z.string().describe("The node's own Cardano address, derived from its key hash"),
	balanceLovelace: z.string(),
	transferredLovelace: z
		.string()
		.nullable()
		.describe('Null unless this request started a transfer; read `outcome` for why'),
	outcome: z
		.enum(['sent', 'sufficient', 'in-flight'])
		.describe(
			'`sent`: a transfer was started. `sufficient`: the node already holds enough. `in-flight`: an earlier transfer to this node has not confirmed yet, so nothing was sent. The balance below is still the pre-transfer one.',
		),
});

// --- GET: is this node funded enough to act on chain? ---

export const participantFundingSchemaInput = z.object({ id: z.string().min(1) });

export const participantFundingSchemaOutput = z.object({
	autoFund: z.boolean(),
	automaticFundingLimitLovelace: z
		.string()
		.nullable()
		.describe('Lifetime node funding limit in lovelace. Null means unlimited.'),
	fundedLovelace: z
		.string()
		.describe('Queued or confirmed funding to this address, including historical and manual transfers.'),
	remainingFundingLovelace: z.string().nullable(),
	address: z.string(),
	balanceLovelace: z.string(),
	isUnderfunded: z.boolean(),
	shortfallLovelace: z.string(),
	checked: z.boolean().describe('False when the chain could not be consulted — unknown, not zero'),
	/**
	 * Whether the node can be driven right now.
	 *
	 * Provisioned is not the same as ready: a node has to start and catch up on
	 * chain first, and an L1 action attempted in that window fails as
	 * "unreachable", which names the symptom rather than the cause.
	 */
	node: z.object({
		state: z.string(),
		isReady: z.boolean(),
		reason: z.string().nullable().describe('Why it is not ready, when it is not'),
	}),
});

/**
 * Read before an L1 action rather than after it fails.
 *
 * Init that fails for want of funds fails slowly and says nothing about money:
 * the node posts nothing, the service waits out its timeout, and the operator
 * sees a gateway timeout. Asking first turns that into a sentence with a number
 * in it.
 */
export const participantFundingGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: participantFundingSchemaInput,
	output: participantFundingSchemaOutput,
	handler: async ({ input }) => {
		const [state, node, policy] = await Promise.all([
			readNodeFundingState(input.id),
			readParticipantNodeState(input.id),
			readNodeFundingPolicy(input.id),
		]);
		return {
			...policy,
			address: state.address,
			balanceLovelace: state.balanceLovelace.toString(),
			isUnderfunded: state.isUnderfunded,
			shortfallLovelace: state.shortfallLovelace.toString(),
			checked: state.checked,
			node,
		};
	},
});

/**
 * Top up the node's Cardano key now, rather than waiting for the funding cycle.
 *
 * A node cannot open a head from an empty address: Init consumes a seed UTxO
 * there and pays its fee from the same key, so a freshly provisioned node fails
 * with `NoSeedInput`. The scheduled cycle covers this, but the wait is worst on
 * the first head an operator opens — when the failure is least legible and the
 * fix is invisible.
 *
 * Queues a transfer rather than performing one: the existing fund-transfer
 * lifecycle owns building, signing, submitting and confirming, and duplicating
 * that here would mean a second path to get wrong.
 */
export const fundParticipantNodePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: fundParticipantNodeInput,
	output: fundParticipantNodeOutput,
	handler: async ({ input }) => {
		return await fundHydraNodeNow(input.id);
	},
});

const MAX_DATABASE_BIGINT = 9_223_372_036_854_775_807n;
const fundingLimit = z
	.string()
	.max(19)
	.regex(/^(0|[1-9][0-9]*)$/)
	.refine(
		(value) => value.length <= 19 && /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= MAX_DATABASE_BIGINT,
		'Funding limit exceeds the database maximum',
	);

export const participantFundingSettingsInput = z
	.object({
		id: z.string().min(1),
		autoFund: z.boolean().optional(),
		automaticFundingLimitLovelace: fundingLimit
			.nullable()
			.optional()
			.describe('Null removes the limit. Zero blocks automatic funding.'),
	})
	.refine(
		(input) => input.autoFund !== undefined || input.automaticFundingLimitLovelace !== undefined,
		'Supply an automatic funding setting',
	);

export const participantFundingSettingsOutput = z.object({
	id: z.string(),
	autoFund: z.boolean(),
	automaticFundingLimitLovelace: z.string().nullable(),
});

export const participantFundingPatch = adminAuthenticatedEndpointFactory.build({
	method: 'patch',
	input: participantFundingSettingsInput,
	output: participantFundingSettingsOutput,
	handler: async ({ input }) => {
		const updated = await withSerializableSlotRetry(() =>
			prisma.$transaction(
				async (tx) => {
					const participant = await tx.hydraLocalParticipant.findUnique({
						where: { id: input.id },
						select: { id: true },
					});
					if (participant === null) throw createHttpError(404, 'Local participant not found');
					return await tx.hydraLocalParticipant.update({
						where: { id: input.id },
						data: {
							...(input.autoFund !== undefined ? { autoFund: input.autoFund } : {}),
							...(input.automaticFundingLimitLovelace !== undefined
								? {
										automaticFundingLimitLovelace:
											input.automaticFundingLimitLovelace === null ? null : BigInt(input.automaticFundingLimitLovelace),
									}
								: {}),
						},
						select: { id: true, autoFund: true, automaticFundingLimitLovelace: true },
					});
				},
				{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
			),
		);
		return { ...updated, automaticFundingLimitLovelace: updated.automaticFundingLimitLovelace?.toString() ?? null };
	},
});
