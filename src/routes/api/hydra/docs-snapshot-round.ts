// OpenAPI docs for a snapshot round that stopped moving, and its admin reset.
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	resetSnapshotRoundInput,
	resetSnapshotRoundOutput,
	snapshotRoundInput,
	snapshotRoundOutput,
} from '@/routes/api/hydra/head/snapshot-round';

const HEAD_ID = 'cuid_v2_auto_generated';
const TAG = ['hydra'];
const TX_ID = 'dc3edee5c3eb0b5b50809ec9fa41fb590818412383da4f03cbf645fb0c1728e7';
const SIGNATURE = 'SeenSnapshot|314|1';

export function registerHydraSnapshotRoundPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const unauthorized = { 401: { description: 'Unauthorized' } } as const;
	const notFound = { 404: { description: 'Hydra head not found' } } as const;
	registry.registerPath({
		method: 'get',
		path: '/hydra/head/snapshot-round',
		summary: "Read the head's snapshot round in flight. (admin access required)",
		description:
			'Live view of the snapshot round our node reports (`GET /snapshot/last-seen`). A round needs every party to sign; when one party can never sign it, the head confirms nothing until the round is reset. `stuck` turns true once the same round has not moved for ten minutes, and the HYDRA_HEAD_SNAPSHOT_ROUND_STUCK webhook fires once per round.',
		tags: TAG,
		security: secured,
		request: { query: snapshotRoundInput },
		responses: {
			200: successResponse('Snapshot round', snapshotRoundOutput, {
				headId: HEAD_ID,
				inFlight: true,
				tag: 'SeenSnapshot',
				snapshotNumber: 314,
				signatoryCount: 1,
				txIds: [TX_ID],
				signature: SIGNATURE,
				since: '1970-01-01T00:00:00.000Z',
				stuck: true,
			}),
			...unauthorized,
			...notFound,
			400: { description: 'Head has no local participant' },
			409: { description: 'Head not open' },
			502: { description: 'No live connection to the head, or the node did not answer' },
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/head/snapshot-round/reset',
		summary: 'Reset a stuck snapshot round. (admin access required)',
		description:
			"Side-loads the node's own latest confirmed snapshot, Hydra's documented recovery for a stuck head. That snapshot is already signed by every party, so nothing new enters the head: the stuck round and its unconfirmed transactions (`droppedTxIds`) are discarded. Refused unless the round in flight still matches `expectedSignature` and has been stuck for ten minutes. If the head still does not move afterwards, the other party's node holds a stuck round too and must be reset on its side.",
		tags: TAG,
		security: secured,
		request: {
			body: {
				content: {
					'application/json': {
						schema: resetSnapshotRoundInput.openapi({ example: { headId: HEAD_ID, expectedSignature: SIGNATURE } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Round reset', resetSnapshotRoundOutput, {
				headId: HEAD_ID,
				confirmedSnapshotNumber: 313,
				droppedTxIds: [TX_ID],
				roundAfter: { tag: 'LastSeenSnapshot', snapshotNumber: null },
			}),
			...unauthorized,
			...notFound,
			400: { description: 'Head has no local participant' },
			409: {
				description:
					'Head not open or disabled, no round in flight, the round changed since it was read, it is not stuck long enough, or the confirmed snapshot does not match the verified one',
			},
			502: { description: 'No live connection to the head, or the node refused the reset or is still stuck' },
			504: { description: 'The node did not answer the reset; read the round again before retrying' },
		},
	});
}
