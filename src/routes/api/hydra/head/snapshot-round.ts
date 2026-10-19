import { adminAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import { getSnapshotRoundStatus, resetSnapshotRound } from '@/services/hydra-snapshot-round/reset';

const roundShape = {
	tag: z.string().describe('The last-seen tag our node reports, for example SeenSnapshot or LastSeenSnapshot'),
	snapshotNumber: z.number().int().nullable().describe('The snapshot number under signature, if named'),
};

export const snapshotRoundInput = z.object({
	headId: z.string().max(64).describe('The Hydra head to inspect'),
});

export const snapshotRoundOutput = z.object({
	headId: z.string(),
	inFlight: z.boolean().describe('Whether our node reports a snapshot round in flight'),
	...roundShape,
	signatoryCount: z.number().int().describe('Parties that have signed the round so far'),
	txIds: z.array(z.string()).describe('Unconfirmed transactions the round would confirm, and a reset would drop'),
	signature: z.string().describe('Identifies this exact round. A reset must send it back unchanged.'),
	since: z.string().nullable().describe('When this exact round was first recorded'),
	stuck: z.boolean().describe('True once the same round has not moved for ten minutes. Only then can it be reset.'),
});

/** Live view of the head's snapshot round, read from our node. */
export const getSnapshotRoundGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: snapshotRoundInput,
	output: snapshotRoundOutput,
	handler: async ({ input }) => {
		const status = await getSnapshotRoundStatus(input.headId);
		return { ...status, since: status.since?.toISOString() ?? null };
	},
});

export const resetSnapshotRoundInput = z.object({
	headId: z.string().max(64).describe('The Hydra head whose stuck round to reset'),
	expectedSignature: z
		.string()
		.min(1)
		.max(200)
		.describe('The round signature from GET /hydra/head/snapshot-round. The reset is refused if the round changed.'),
});

export const resetSnapshotRoundOutput = z.object({
	headId: z.string(),
	confirmedSnapshotNumber: z.number().int().describe('The signed snapshot the node was reset to'),
	droppedTxIds: z.array(z.string()).describe('Unconfirmed transactions the reset discarded'),
	roundAfter: z.object(roundShape).nullable().describe('The node’s round after the reset, when it could be read'),
});

/**
 * Reset a stuck snapshot round by side-loading the node's own confirmed
 * snapshot. Nothing new enters the head; the stuck round and its unconfirmed
 * transactions are discarded. Refused unless the round is the one the caller
 * saw and has been stuck for the threshold.
 */
export const resetSnapshotRoundPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: resetSnapshotRoundInput,
	output: resetSnapshotRoundOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof resetSnapshotRoundInput>; ctx: AuthContext }) =>
		await resetSnapshotRound({
			headId: input.headId,
			expectedSignature: input.expectedSignature,
			actorApiKeyId: ctx.id,
		}),
});
