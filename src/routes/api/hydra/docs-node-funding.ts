import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';
import {
	fundParticipantNodeInput,
	fundParticipantNodeOutput,
	participantFundingSchemaInput,
	participantFundingSchemaOutput,
	withdrawParticipantNodeInput,
	withdrawParticipantNodeOutput,
	participantFundingSettingsInput,
	participantFundingSettingsOutput,
} from './participant';

const TAG = ['hydra'];
const jsonBody = (schema: Parameters<typeof successResponse>[1], example: unknown) => ({
	content: { 'application/json': { schema: schema.openapi({ example }) } },
});

export function registerHydraNodeFundingPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	const secured = [{ [apiKeyAuth.name]: [] }];
	const unauthorized = { 401: { description: 'Unauthorized' } } as const;
	const notFound = { 404: { description: 'Local participant not found' } } as const;
	// ---- participant: node fuel ----
	registry.registerPath({
		method: 'get',
		path: '/hydra/participant/local/fund',
		summary: "Read a node's own balance and funding history. (admin access required)",
		description:
			"A hydra-node posts its head's L1 transactions from a Cardano key of its own, so it needs ADA that is not the head's. This reports what it holds and what has been sent to it.",
		tags: TAG,
		security: secured,
		request: { query: participantFundingSchemaInput },
		responses: {
			200: successResponse('Node funding', participantFundingSchemaOutput, { id: 'cuid_v2_auto_generated' }),
			...unauthorized,
			...notFound,
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/participant/local/fund',
		summary: "Send ADA to a node's own Cardano key. (admin access required)",
		description:
			'Tops the node up now rather than waiting for the funding cycle. Without this balance the node cannot post an Init, a Close or a Fanout.',
		tags: TAG,
		security: secured,
		request: { body: jsonBody(fundParticipantNodeInput, { id: 'cuid_v2_auto_generated' }) },
		responses: {
			200: successResponse('Node funding result', fundParticipantNodeOutput, { id: 'cuid_v2_auto_generated' }),
			...unauthorized,
			...notFound,
			// No 409 for a node that needs nothing, or for one whose earlier transfer
			// is still unconfirmed: both answer 200 and say which in `outcome`.
			// Reporting them as refusals told the operator to go and fix something.
		},
	});
	registry.registerPath({
		method: 'post',
		path: '/hydra/participant/local/withdraw',
		summary: 'Sweep what a node did not spend back to its wallet. (admin access required)',
		description:
			"Returns the node's remaining ADA once its head is final. Refused while the head is still live or an invite still holds the node, because the node would need those funds.",
		tags: TAG,
		security: secured,
		request: { body: jsonBody(withdrawParticipantNodeInput, { id: 'cuid_v2_auto_generated' }) },
		responses: {
			200: successResponse('Node sweep result', withdrawParticipantNodeOutput, { id: 'cuid_v2_auto_generated' }),
			...unauthorized,
			...notFound,
			409: { description: 'The node is still needed, so its funds are kept' },
		},
	});

	registry.registerPath({
		method: 'patch',
		path: '/hydra/participant/local/fund',
		summary: 'Set optional automatic node funding limits. (admin access required)',
		description:
			'Automatic funding is unlimited by default. A lifetime limit counts pending and confirmed transfers to the node address, including manual and historical transfers. A refill is skipped if it would exceed the limit. Explicit admin funding remains available.',
		tags: TAG,
		security: secured,
		request: {
			body: jsonBody(participantFundingSettingsInput, {
				id: 'cuid_v2_auto_generated',
				automaticFundingLimitLovelace: null,
			}),
		},
		responses: {
			200: successResponse('Automatic funding settings', participantFundingSettingsOutput, {
				id: 'cuid_v2_auto_generated',
				autoFund: true,
				automaticFundingLimitLovelace: null,
			}),
			...unauthorized,
			...notFound,
		},
	});
}
