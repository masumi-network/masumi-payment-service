// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import {
	acknowledgeManualActionSchemaInput,
	acknowledgeManualActionSchemaOutput,
} from '@/routes/api/acknowledge-manual-action';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const bodyExample = {
	network: 'Preprod',
	blockchainIdentifiers: ['blockchain_identifier'],
};

export function registerAcknowledgeManualActionPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	for (const kind of ['payment', 'purchase'] as const) {
		registry.registerPath({
			method: 'post',
			path: `/${kind}/acknowledge-manual-action`,
			description: `Hides ${kind} requests from Needs Action (filterNeedsManualAction). Only the acknowledgement is stored: NextAction, error fields, transactions and on-chain state do not change. The acknowledgement is cleared when the requested action or the error changes, so a new error shows up again. Identifiers that are not in Needs Action, not found, or outside the caller's scope are skipped. Only the creating key or an admin key can acknowledge a request.`,
			summary: `Acknowledge ${kind} requests in Needs Action (PAY access required)`,
			tags: ['error-state-recovery'],
			security: [{ [apiKeyAuth.name]: [] }],
			request: {
				body: {
					description: 'Requests to acknowledge',
					content: {
						'application/json': {
							schema: acknowledgeManualActionSchemaInput.openapi({ example: bodyExample }),
						},
					},
				},
			},
			responses: {
				200: successResponse('Acknowledged count', acknowledgeManualActionSchemaOutput, { acknowledgedCount: 1 }),
				400: { description: 'Bad Request (invalid input)' },
				401: { description: 'Unauthorized' },
			},
		});
	}
}
