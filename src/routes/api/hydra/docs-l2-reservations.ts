// OpenAPI docs for expired L2 reservations no proof can release, and their admin release.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	l2ReservationsInput,
	l2ReservationsOutput,
	releaseL2ReservationInput,
	releaseL2ReservationOutput,
} from '@/routes/api/hydra/head/l2-reservations';

const HEAD_ID = 'cuid_v2_auto_generated';
const TRANSACTION_ID = 'cuid_v2_auto_generated';
const PURCHASE_ID = 'cuid_v2_auto_generated';
const TAG = ['hydra'];
const TX_ID = 'dc3edee5c3eb0b5b50809ec9fa41fb590818412383da4f03cbf645fb0c1728e7';
const NUDGE_TX_ID = '5f2e1c7a9b3d4e6f8a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f';
const UPDATED_AT = '1970-01-01T00:00:00.000Z';

export function registerHydraL2ReservationPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const unauthorized = { 401: { description: 'Unauthorized' } } as const;
	registry.registerPath({
		method: 'get',
		path: '/hydra/head/l2-reservations',
		summary: 'List the pending L2 reservations on a head. (admin access required)',
		description:
			'Each in-head transaction the service reserved a wallet for and has not seen confirmed. Automatic recovery releases an expired one only when its release nudge shows up in a verified snapshot. Some can never get that proof (a body input already spent elsewhere, a nudge output spent before release read it, or a non-locking action), and they hold their wallet until an admin releases them. `releasable` says whether the release endpoint will accept the row now.',
		tags: TAG,
		security: secured,
		request: { query: l2ReservationsInput },
		responses: {
			200: successResponse('L2 reservations', l2ReservationsOutput, {
				headId: HEAD_ID,
				reservations: [
					{
						transactionId: TRANSACTION_ID,
						updatedAt: UPDATED_AT,
						intendedTxHash: TX_ID,
						expiresAt: UPDATED_AT,
						kind: 'initial-lock',
						purchaseRequestIds: [PURCHASE_ID],
						paymentRequestIds: [],
						walletAddress:
							'addr_test1qp6ctf8vcjxzd53et7p0hlqyncn59stnfd4g8mp978v33r6dlzjvt4s2t6wn3v993pu9aea4h3z0jeyn6lsvw6hugtesfx55dd',
						inputRefs: [`${TX_ID}#1`],
						inputsReportedUnspent: 0,
						releaseNudgeTxHash: NUDGE_TX_ID,
						rejectedByHeadReason: null,
						releasable: true,
						blockedReason: null,
					},
				],
			}),
			...unauthorized,
			404: { description: 'Hydra head not found' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/l2-reservations/release',
		summary: 'Release an expired L2 reservation without a proof. (admin access required)',
		description:
			'Frees the wallet and returns each request to where the reservation found it: an initial lock goes back to locking, an action back to its retry. The service cannot prove the body never applied in a snapshot its node withheld, so check the other party’s node or L1 first and send `acknowledgeUnprovable: true`. Refused unless the head is open with a live, verified session, the body is past its validity bound on the head’s clock by the release grace (5 minutes), or by 30 minutes when automatic recovery could still prove it dead, our node shows no confirmation of it, and the row is unchanged since `expectedUpdatedAt`. If the body confirms later, the head’s replay halts for review instead of applying it.',
		tags: TAG,
		security: secured,
		request: {
			body: {
				content: {
					'application/json': {
						schema: releaseL2ReservationInput.openapi({
							example: {
								headId: HEAD_ID,
								transactionId: TRANSACTION_ID,
								expectedUpdatedAt: UPDATED_AT,
								acknowledgeUnprovable: true,
							},
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Reservation released', releaseL2ReservationOutput, {
				transactionId: TRANSACTION_ID,
				purchaseRequestIds: [PURCHASE_ID],
				paymentRequestIds: [],
			}),
			...unauthorized,
			404: { description: 'Hydra head or pending L2 reservation not found' },
			409: {
				description:
					'Head not open or closing, the row changed since it was read, the body is not provably expired or shows confirmed, or a request on it is in an action that cannot be restored',
			},
			502: { description: 'No live connection to the head' },
		},
	});
}
