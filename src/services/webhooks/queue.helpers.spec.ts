import { WebhookEventType } from '@/generated/prisma/enums';
import { buildEndpointWebhookPayload, buildWebhookPayload, mergeWebhookEndpointBatch } from './queue.helpers';

describe('webhook queue helpers', () => {
	it('deduplicates inclusive cursor overlap between endpoint batches', () => {
		const firstBatch = [{ id: 'endpoint-1' }, { id: 'endpoint-2' }];
		const secondBatch = [{ id: 'endpoint-2' }, { id: 'endpoint-3' }];

		const firstMerge = mergeWebhookEndpointBatch([], firstBatch);
		const secondMerge = mergeWebhookEndpointBatch(firstMerge.mergedEndpoints, secondBatch);

		expect(firstMerge.newEndpoints.map((endpoint) => endpoint.id)).toEqual(['endpoint-1', 'endpoint-2']);
		expect(secondMerge.newEndpoints.map((endpoint) => endpoint.id)).toEqual(['endpoint-3']);
		expect(secondMerge.mergedEndpoints.map((endpoint) => endpoint.id)).toEqual([
			'endpoint-1',
			'endpoint-2',
			'endpoint-3',
		]);
		expect(secondMerge.nextCursorId).toBe('endpoint-3');
	});

	it('builds per-endpoint payloads without mutating the base payload', () => {
		const basePayload = buildWebhookPayload(
			WebhookEventType.WALLET_LOW_BALANCE,
			{
				ruleId: 'rule-1',
				walletId: 'wallet-1',
				walletAddress: 'addr_test1...',
				walletVkey: 'wallet-vkey',
				walletType: 'Selling',
				paymentSourceId: 'payment-source-1',
				network: 'Preprod',
				assetUnit: 'lovelace',
				thresholdAmount: '1000000',
				currentAmount: '500000',
				checkedAt: '2026-03-09T12:00:00.000Z',
			},
			'2026-03-09T12:00:00.000Z',
		);
		const endpointPayload = buildEndpointWebhookPayload(basePayload, 'endpoint-1');

		expect(basePayload.webhook_id).toBe('');
		expect(endpointPayload).toEqual({
			event_type: WebhookEventType.WALLET_LOW_BALANCE,
			timestamp: '2026-03-09T12:00:00.000Z',
			webhook_id: 'endpoint-1',
			data: {
				ruleId: 'rule-1',
				walletId: 'wallet-1',
				walletAddress: 'addr_test1...',
				walletVkey: 'wallet-vkey',
				walletType: 'Selling',
				paymentSourceId: 'payment-source-1',
				network: 'Preprod',
				assetUnit: 'lovelace',
				thresholdAmount: '1000000',
				currentAmount: '500000',
				checkedAt: '2026-03-09T12:00:00.000Z',
			},
		});
	});
});
