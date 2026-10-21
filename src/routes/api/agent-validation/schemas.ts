import { z } from '@masumi/payment-core/zod';

export const PROBE_ENDPOINTS = [
	'availability',
	'input_schema',
	'demo',
	'start_job',
	'status',
	'provide_input',
] as const;

const MAX_INPUT_FIELDS = 100;
const MAX_INPUT_BYTES = 262_144;
const MAX_JSON_TEXT_LENGTH = 200_000;

// MIP-003 form input is flat: one value per field id (text, number, boolean, or a list of chosen options).
const inputDataValueSchema = z.union([
	z.string().max(10_000),
	z.number(),
	z.boolean(),
	z.null(),
	z.array(z.string().max(1_000)).max(100),
]);

const inputDataSchema = z
	.record(z.string().max(250), inputDataValueSchema)
	.refine((value) => Object.keys(value).length <= MAX_INPUT_FIELDS, {
		message: `At most ${MAX_INPUT_FIELDS} input fields`,
	})
	.refine((value) => JSON.stringify(value).length <= MAX_INPUT_BYTES, {
		message: `Input data may be at most ${MAX_INPUT_BYTES} bytes when serialized`,
	});

export const agentValidationCheckSchema = z
	.object({
		id: z.string().describe('Stable check id, e.g. "agent.availability.type"'),
		status: z
			.enum(['pass', 'warn', 'fail', 'skipped'])
			.describe('fail = breaks registry listing or payment; warn = spec drift or risk; skipped = not applicable yet'),
		label: z.string().describe('What was checked'),
		detail: z.string().nullable().describe('What was observed'),
		fix: z.string().nullable().describe('What to change to resolve it'),
		docsUrl: z.string().nullable().describe('Documentation for the fix'),
	})
	.openapi('AgentValidationCheck');

export const agentValidationProbeSchemaInput = z.object({
	apiBaseUrl: z
		.string()
		.trim()
		.max(250)
		.describe('Base URL of the agent, as it is (or will be) registered. The endpoint path is appended to it.'),
	endpoint: z
		.enum(PROBE_ENDPOINTS)
		.describe(
			'Which MIP-003 endpoint to call. The path suffix appended to apiBaseUrl is fixed per endpoint; only the base path comes from apiBaseUrl.',
		),
	jobId: z.string().min(1).max(250).optional().describe('Job id. Required for status and provide_input.'),
	identifierFromPurchaser: z
		.string()
		.min(1)
		.max(250)
		.optional()
		.describe(
			'The nonce sent in start_job. Required for start_job and provide_input; used to recompute the MIP-004 hash.',
		),
	inputData: inputDataSchema
		.optional()
		.describe('The input_data sent to start_job or provide_input. Defaults to an empty object.'),
	inputSchemaHash: z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.optional()
		.describe(
			'Required for provide_input: lowercase hex SHA-256 of the canonical input_schema returned by /status. Ignored by other endpoints.',
		),
	expectedAgentIdentifier: z
		.string()
		.max(250)
		.optional()
		.describe('The on-chain agent identifier, once the agent is registered. Enables the identifier comparisons.'),
	isFreeAgent: z.boolean().optional().describe('Free agents only return an id from start_job.'),
});

export const agentValidationProbeSchemaOutput = z.object({
	httpStatus: z
		.number()
		.int()
		.nullable()
		.describe('HTTP status of the agent response. Null when no request was sent or it failed.'),
	durationMs: z.number().int().min(0).describe('Time the request took in milliseconds'),
	redirectedTo: z.string().nullable().describe('Where the agent redirected to. Redirects are never followed.'),
	bodyText: z.string().nullable().describe('First 20 000 characters of the response body'),
	Checks: z.array(agentValidationCheckSchema).describe('Findings, each with the reason and the fix'),
});

export const agentValidationValidateSchemaInput = z.object({
	kind: z
		.enum(['input_schema', 'coworker_metadata'])
		.describe('input_schema checks a MIP-003 input schema; coworker_metadata checks Sokosumi coworker metadata.'),
	json: z.string().min(1).max(MAX_JSON_TEXT_LENGTH).describe('The JSON text to check'),
});

export const agentValidationValidateSchemaOutput = z.object({
	Checks: z.array(agentValidationCheckSchema).describe('Findings, each with the reason and the fix'),
});

export const agentValidationHashSchemaInput = z.object({
	kind: z
		.enum(['input', 'result', 'input_schema'])
		.describe('Which MIP-004 / MIP-003 hash to compute: the input hash, the result hash or the input schema hash.'),
	identifierFromPurchaser: z
		.string()
		.min(1)
		.max(250)
		.optional()
		.describe('The purchaser nonce. Required for input and result.'),
	inputData: inputDataSchema.optional().describe('The input_data to hash (kind input). Defaults to an empty object.'),
	result: z.string().max(MAX_JSON_TEXT_LENGTH).optional().describe('The result text to hash (kind result).'),
	json: z
		.string()
		.max(MAX_JSON_TEXT_LENGTH)
		.optional()
		.describe('The input_schema JSON text to hash (kind input_schema).'),
});

export const agentValidationHashSchemaOutput = z.object({
	hash: z.string().describe('Lowercase hex SHA-256'),
	preimage: z
		.string()
		.describe('The exact string that was hashed, for comparing with what an agent computes character by character'),
});
