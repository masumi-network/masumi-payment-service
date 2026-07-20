// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import {
	getFundDistributionSchemaInput,
	getFundDistributionSchemaOutput,
	triggerFundDistributionSchemaInput,
	triggerFundDistributionSchemaOutput,
} from '@/routes/api/fund-distribution/schemas';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const fundDistributionExample = {
	id: 'cuid_v2_auto_generated',
	createdAt: '2024-01-01T00:00:00.000Z',
	updatedAt: '2024-01-01T00:00:00.000Z',
	fundWalletId: 'cuid_v2_auto_generated',
	targetWalletId: 'cuid_v2_auto_generated',
	priority: 'Warning',
	assetUnit: 'lovelace',
	amount: '100000000',
	status: 'Confirmed',
	txHash: 'a1b2c3d4e5f6...',
	error: null,
	batchId: 'cuid_v2_auto_generated',
};

export function registerFundDistributionPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];

	registry.registerPath({
		method: 'get',
		path: '/fund-distribution',
		description:
			'Lists fund distribution requests, newest first. A request moves Pending -> Submitted -> Confirmed, or to Failed if it could not be sent or never landed on chain. Requests sharing a batchId went out in one transaction. Pagination is cursor-inclusive: the cursor row is returned again, so clients should dedupe by id.',
		summary: 'List fund distribution requests. (admin access required)',
		tags: ['fund-distribution'],
		security: secured,
		request: {
			query: getFundDistributionSchemaInput.openapi({
				example: { paymentSourceId: 'cuid_v2_auto_generated', status: 'Confirmed', take: 20 },
			}),
		},
		responses: {
			200: successResponse('Fund distribution requests', getFundDistributionSchemaOutput, {
				FundDistributions: [fundDistributionExample],
			}),
			401: { description: 'Unauthorized' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/fund-distribution/trigger',
		description:
			'Runs a distribution cycle now instead of waiting for the next scheduled one. Returns immediately; the cycle runs in the background, so a 200 means the request was accepted, not that any funds moved. If a cycle is already running this is a no-op and alreadyRunning is true.',
		summary: 'Trigger a fund distribution cycle. (admin access required)',
		tags: ['fund-distribution'],
		security: secured,
		request: {
			body: {
				description: 'No parameters',
				content: { 'application/json': { schema: triggerFundDistributionSchemaInput.openapi({ example: {} }) } },
			},
		},
		responses: {
			200: successResponse('Distribution cycle triggered', triggerFundDistributionSchemaOutput, {
				triggered: true,
				alreadyRunning: false,
			}),
			401: { description: 'Unauthorized' },
		},
	});
}
