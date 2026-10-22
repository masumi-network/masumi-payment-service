import { adminAuthenticatedEndpointFactory, type AuthContext } from '@masumi/payment-core/auth';
import { z } from '@masumi/payment-core/zod';
import {
	listHeldL2Reservations,
	releaseHeldL2Reservation,
} from '@masumi/payment-source-v2/services/hydra-reconcile/operator-l2-reservation-release';
import {
	findStalledReleasedL2Reservation,
	reapplyReleasedL2Reservation,
} from '@masumi/payment-source-v2/services/hydra-reconcile/operator-l2-reservation-reapply';

export const l2ReservationsInput = z.object({
	headId: z.string().max(64).describe('The Hydra head to inspect'),
});

const reservationShape = z.object({
	transactionId: z.string(),
	updatedAt: z.string().describe('Send it back to release; the release is refused if the row changed'),
	intendedTxHash: z.string().nullable().describe('Hash of the reserved in-head body'),
	expiresAt: z.string().nullable().describe("The body's validity upper bound, as head time"),
	kind: z.enum(['initial-lock', 'action']).describe('An initial lock, or an action on an existing escrow'),
	purchaseRequestIds: z.array(z.string()),
	paymentRequestIds: z.array(z.string()),
	walletAddress: z.string().nullable().describe('The wallet this reservation holds'),
	inputRefs: z.array(z.string()).describe('Inputs (txHash#index) the body spends'),
	inputsReportedUnspent: z
		.number()
		.int()
		.nullable()
		.describe("Body inputs our node reports unspent. Read from the node's reference map: a hint, not evidence."),
	releaseNudgeTxHash: z.string().nullable().describe('The recorded release nudge, if one was sent'),
	rejectedByHeadReason: z.string().nullable(),
	releasable: z
		.boolean()
		.describe(
			"Whether an admin may release it now. The release also re-reads the node's snapshot round and UTxO set, and can still refuse.",
		),
	blockedReason: z.string().nullable().describe('Why it cannot be released now'),
});

export const l2ReservationsOutput = z.object({
	headId: z.string(),
	reservations: z.array(reservationShape),
});

/** Pending L2 reservations on the head, for an admin to review. */
export const listL2ReservationsGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: l2ReservationsInput,
	output: l2ReservationsOutput,
	handler: async ({ input }) => {
		const result = await listHeldL2Reservations(input.headId);
		return {
			headId: result.headId,
			reservations: result.reservations.map((reservation) => ({
				...reservation,
				updatedAt: reservation.updatedAt.toISOString(),
				expiresAt: reservation.expiresAt?.toISOString() ?? null,
			})),
		};
	},
});

export const releaseL2ReservationInput = z.object({
	headId: z.string().max(64).describe('The Hydra head the reservation is on'),
	transactionId: z.string().max(64).describe('The reservation to release'),
	expectedUpdatedAt: z.iso.datetime().describe('updatedAt from GET /hydra/head/l2-reservations'),
	acknowledgeUnprovable: z
		.literal(true)
		.describe(
			'Confirms the admin checked, on the other party’s node or on L1, that the body did not apply. The service cannot prove it.',
		),
});

export const releaseL2ReservationOutput = z.object({
	transactionId: z.string(),
	purchaseRequestIds: z.array(z.string()).describe('Purchases returned to where the reservation found them'),
	paymentRequestIds: z.array(z.string()).describe('Payments returned to their retry action'),
});

/**
 * Release an expired L2 reservation that automatic recovery cannot prove dead.
 * It frees the wallet and returns each request to where the reservation found
 * it. If the body later confirms anyway, the head's replay halts for review.
 */
export const releaseL2ReservationPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: releaseL2ReservationInput,
	output: releaseL2ReservationOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof releaseL2ReservationInput>; ctx: AuthContext }) =>
		await releaseHeldL2Reservation({
			headId: input.headId,
			transactionId: input.transactionId,
			expectedUpdatedAt: new Date(input.expectedUpdatedAt),
			actorApiKeyId: ctx.id,
		}),
});

const stalledReleaseShape = z.object({
	transactionId: z.string(),
	updatedAt: z.string().describe('Send it back to re-apply; the call is refused if the row changed'),
	intendedTxHash: z.string().describe('Hash of the released body that confirmed in the head'),
	releasedBy: z.enum(['input-proof', 'operator']).describe('Who released the reservation'),
	releasedAt: z.string(),
	kind: z.enum(['initial-lock', 'action']).describe('An initial lock, or an action on an existing escrow'),
	purchaseRequestIds: z.array(z.string()),
	paymentRequestIds: z.array(z.string()),
	reapplicable: z.boolean().describe('Whether an admin may re-apply it now'),
	blockedReason: z.string().nullable().describe('Why it cannot be re-applied now'),
});

export const stalledReleaseOutput = z.object({
	headId: z.string(),
	reservation: stalledReleaseShape.nullable().describe('Null when replay is not held on a released reservation'),
});

/** The released reservation whose confirmed body holds the head's replay, if any. */
export const stalledReleaseGet = adminAuthenticatedEndpointFactory.build({
	method: 'get',
	input: l2ReservationsInput,
	output: stalledReleaseOutput,
	handler: async ({ input }) => {
		const { headId, reservation } = await findStalledReleasedL2Reservation(input.headId);
		return {
			headId,
			reservation: reservation && {
				...reservation,
				updatedAt: reservation.updatedAt.toISOString(),
				releasedAt: reservation.releasedAt.toISOString(),
			},
		};
	},
});

export const reapplyL2ReservationInput = z.object({
	headId: z.string().max(64).describe('The Hydra head whose replay is held'),
	transactionId: z.string().max(64).describe('The released reservation to re-apply'),
	expectedUpdatedAt: z.iso.datetime().describe('updatedAt from GET /hydra/head/l2-reservations/stalled-release'),
});

export const reapplyL2ReservationOutput = z.object({
	transactionId: z.string(),
	purchaseRequestIds: z.array(z.string()).describe('Purchases put back on the reservation'),
	paymentRequestIds: z.array(z.string()).describe('Payments put back on the reservation'),
});

/**
 * Undo the release of an action reservation whose body confirmed anyway, so
 * the head's next replay pass applies it. Initial locks are refused.
 */
export const reapplyL2ReservationPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: reapplyL2ReservationInput,
	output: reapplyL2ReservationOutput,
	handler: async ({ input, ctx }: { input: z.infer<typeof reapplyL2ReservationInput>; ctx: AuthContext }) =>
		await reapplyReleasedL2Reservation({
			headId: input.headId,
			transactionId: input.transactionId,
			expectedUpdatedAt: new Date(input.expectedUpdatedAt),
			actorApiKeyId: ctx.id,
		}),
});
