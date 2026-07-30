// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import {
	deleteTxSyncQuarantineSchemaInput,
	deleteTxSyncQuarantineSchemaOutput,
	getTxSyncQuarantineSchemaInput,
	getTxSyncQuarantineSchemaOutput,
	retryTxSyncQuarantineSchemaInput,
	retryTxSyncQuarantineSchemaOutput,
} from '@/routes/api/tx-sync-quarantine';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const quarantineEntryExample = {
	id: 'quarantine_entry_id',
	createdAt: '2024-01-01T00:00:00.000Z',
	updatedAt: '2024-01-01T00:05:00.000Z',
	txHash: '0000000000000000000000000000000000000000000000000000000000000000',
	blockHeight: 10000000,
	txIndex: 3,
	reason: 'ProcessingFailed',
	attempts: 4,
	lastError: 'Could not decode the datum of output 0',
	nextRetryAt: '2024-01-01T00:10:00.000Z',
	resolvedAt: null,
	needsOperator: true,
	PaymentSource: {
		id: 'payment_source_id',
		network: 'Preprod',
		smartContractAddress: 'addr_test1...',
	},
};

export function registerTxSyncQuarantinePaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];

	registry.registerPath({
		method: 'get',
		path: '/tx-sync-quarantine',
		description:
			'Lists transactions the chain sync could not apply. The checkpoint has already advanced past these, so anything still pending is chain state the database has NOT caught up with — some request is running on stale information until it is applied.',
		summary: 'List quarantined sync transactions. (admin access required)',
		tags: ['tx-sync-quarantine'],
		security: secured,
		request: {
			query: getTxSyncQuarantineSchemaInput.openapi({
				example: { network: 'Preprod', status: 'Unresolved', take: 25 },
			}),
		},
		responses: {
			200: successResponse('Quarantine entries', getTxSyncQuarantineSchemaOutput, {
				Quarantine: [quarantineEntryExample],
			}),
			401: { description: 'Unauthorized' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/tx-sync-quarantine/retry',
		description:
			'Schedules an immediate retry of a quarantined transaction and clears its operator flag. The retry itself is performed by the reconciler, not inline.',
		summary: 'Retry a quarantined sync transaction. (admin access required)',
		tags: ['tx-sync-quarantine'],
		security: secured,
		request: {
			body: {
				description: 'Quarantine entry to retry',
				content: {
					'application/json': {
						schema: retryTxSyncQuarantineSchemaInput.openapi({ example: { id: 'quarantine_entry_id' } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Quarantine entry re-queued', retryTxSyncQuarantineSchemaOutput, {
				...quarantineEntryExample,
				attempts: 0,
				needsOperator: false,
			}),
			400: { description: 'Quarantine entry is already resolved' },
			401: { description: 'Unauthorized' },
			409: { description: 'Quarantine entry is currently being processed or changed concurrently' },
			404: { description: 'Quarantine entry not found' },
		},
	});

	registry.registerPath({
		method: 'delete',
		path: '/tx-sync-quarantine',
		description:
			'Permanently removes a quarantine entry. Deleting does NOT apply the transaction — the database stays behind the chain for whatever that transaction would have changed. Intended for entries that are genuinely irrelevant, or ones already repaired by hand.',
		summary: 'Delete a quarantine entry without applying it. (admin access required)',
		tags: ['tx-sync-quarantine'],
		security: secured,
		request: {
			body: {
				description: 'Quarantine entry to delete',
				content: {
					'application/json': {
						schema: deleteTxSyncQuarantineSchemaInput.openapi({ example: { id: 'quarantine_entry_id' } }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Quarantine entry deleted', deleteTxSyncQuarantineSchemaOutput, {
				id: 'quarantine_entry_id',
				txHash: quarantineEntryExample.txHash,
			}),
			401: { description: 'Unauthorized' },
			409: { description: 'Quarantine entry is currently being processed or changed concurrently' },
			404: { description: 'Quarantine entry not found' },
		},
	});
}
