// Colocated OpenAPI docs for this route area. When you add or change an
// endpoint here, update THIS file in the same PR — CI regenerates
// openapi-docs.json and fails on drift.
import {
	agentValidationHashSchemaInput,
	agentValidationHashSchemaOutput,
	agentValidationProbeSchemaInput,
	agentValidationProbeSchemaOutput,
	agentValidationValidateSchemaInput,
	agentValidationValidateSchemaOutput,
} from './schemas';
import { successResponse, type SwaggerRegistrarContext } from '@/utils/generator/swagger-generator/shared';

const probeRequestExample = {
	apiBaseUrl: 'https://my-agent.example.com',
	endpoint: 'availability' as const,
};

const probeResponseExample = {
	httpStatus: 200,
	durationMs: 143,
	redirectedTo: null,
	bodyText: '{"status":"available","type":"masumi-agent"}',
	Checks: [
		{
			id: 'agent.availability.type',
			status: 'pass' as const,
			label: 'Reports type "masumi-agent"',
			detail: null,
			fix: null,
			docsUrl: null,
		},
		{
			id: 'agent.availability.registry_status',
			status: 'pass' as const,
			label: 'Registry will list this agent as Online',
			detail: 'Online: it reports type "masumi-agent".',
			fix: null,
			docsUrl: null,
		},
	],
};

export function registerAgentValidationPaths({ registry, apiKeyAuth }: SwaggerRegistrarContext) {
	registry.registerPath({
		method: 'post',
		path: '/agent-validation/probe',
		description:
			'Calls one MIP-003 endpoint of an agent (availability, input_schema, demo, start_job, status, provide_input) from the server and returns findings: what the registry or a buyer will see, what is wrong, and how to fix it. For availability the result predicts the registry status (Online, Offline or Invalid) using the same rules as the registry service. The path suffix is fixed per endpoint (the base path comes from apiBaseUrl) and the URL goes through the webhook SSRF policy: local and private addresses are reported as findings and never fetched, redirects are never followed, and responses are capped at 1 MB and 32 seconds. At most two probes run at once.',
		summary: 'Probe an agent endpoint and validate its response. (admin access required)',
		tags: ['agent-validation'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'Which agent endpoint to probe',
				content: {
					'application/json': {
						schema: agentValidationProbeSchemaInput.openapi({ example: probeRequestExample }),
					},
				},
			},
		},
		responses: {
			200: successResponse('Probe result', agentValidationProbeSchemaOutput, probeResponseExample),
			401: { description: 'Unauthorized' },
			503: { description: 'Two probes are already running. Retry later.' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/agent-validation/validate',
		description:
			'Checks pasted JSON with the same rules the probe applies to live agent responses. kind input_schema validates a MIP-003 input schema against Attachment 01 and the marketplace parser; kind coworker_metadata validates Sokosumi coworker metadata. No outbound request is made.',
		summary: 'Validate an input schema or coworker metadata. (admin access required)',
		tags: ['agent-validation'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'The JSON text to check',
				content: {
					'application/json': {
						schema: agentValidationValidateSchemaInput.openapi({
							example: { kind: 'input_schema', json: '{"input_data":[{"id":"topic","type":"text","name":"Topic"}]}' },
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Validation result', agentValidationValidateSchemaOutput, {
				Checks: [
					{
						id: 'agent.input_schema.shape',
						status: 'pass' as const,
						label: 'Schema has input_data or input_groups',
						detail: null,
						fix: null,
						docsUrl: null,
					},
				],
			}),
			401: { description: 'Unauthorized' },
		},
	});

	registry.registerPath({
		method: 'post',
		path: '/agent-validation/hash',
		description:
			'Computes the MIP-004 input hash (sha256 of identifierFromPurchaser + ";" + RFC 8785 canonical input), the result hash (sha256 of identifierFromPurchaser + ";" + the JSON-escaped result) or the MIP-003 input schema hash (sha256 of the canonical schema), exactly as the Sokosumi marketplace verifies them. The response includes the exact string that was hashed, so a mismatch with an agent can be compared character by character.',
		summary: 'Compute a MIP-004 / MIP-003 hash. (admin access required)',
		tags: ['agent-validation'],
		security: [{ [apiKeyAuth.name]: [] }],
		request: {
			body: {
				description: 'What to hash',
				content: {
					'application/json': {
						schema: agentValidationHashSchemaInput.openapi({
							example: { kind: 'input', identifierFromPurchaser: 'abcdef0123456789', inputData: { topic: 'cats' } },
						}),
					},
				},
			},
		},
		responses: {
			200: successResponse('Hash', agentValidationHashSchemaOutput, {
				hash: 'a9f1c87e3420a99c970cdb577243de6cc2500d1ca587325e2a3e305deb0e3d7c',
				preimage: 'abcdef0123456789;{"topic":"cats"}',
			}),
			400: { description: 'A field required for this kind is missing, or json is not valid JSON' },
			401: { description: 'Unauthorized' },
		},
	});
}
