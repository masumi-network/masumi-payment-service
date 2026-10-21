import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import createHttpError from 'http-errors';
import { z } from '@masumi/payment-core/zod';
import { probeAgentEndpoint } from '@/services/agent-validation/probe';
import { computeHash, validateJsonText } from '@/services/agent-validation/tools';
import { concurrencyResponseMiddleware, createConcurrencyLimit } from '@/utils/middleware/concurrency-limit';
import {
	agentValidationHashSchemaInput,
	agentValidationHashSchemaOutput,
	agentValidationProbeSchemaInput,
	agentValidationProbeSchemaOutput,
	agentValidationValidateSchemaInput,
	agentValidationValidateSchemaOutput,
} from './schemas';

export { agentValidationProbeSchemaInput, agentValidationProbeSchemaOutput };

// A probe can hold a socket for up to 32 s (the registry's own timeout), and DNS lookups run on libuv's
// 4-thread pool that the rest of the service shares, so keep this well below that.
const PROBE_CONCURRENCY_LIMIT = 2;
const PROBE_REQUEST_TIMEOUT_MS = 40_000;

const withProbeConcurrency = createConcurrencyLimit({
	limit: PROBE_CONCURRENCY_LIMIT,
	timeoutMs: PROBE_REQUEST_TIMEOUT_MS,
});

const probeEndpointFactory = adminAuthenticatedEndpointFactory.addMiddleware(concurrencyResponseMiddleware);

type HandlerArgs = { input: z.infer<typeof agentValidationProbeSchemaInput> };

/**
 * Calls one MIP-003 endpoint of an agent from the server and reports what is wrong with it.
 *
 * Admin only, and server-side on purpose: agents send no CORS headers, and the registry reaches
 * agents from the server too, so this sees what the registry sees. The URL goes through the same
 * SSRF policy as webhooks; private and local addresses are reported, never fetched.
 */
export const agentValidationProbePost = probeEndpointFactory.build({
	method: 'post',
	input: agentValidationProbeSchemaInput,
	output: agentValidationProbeSchemaOutput,
	handler: withProbeConcurrency(async ({ input }: HandlerArgs) => {
		const result = await probeAgentEndpoint(input);
		return {
			httpStatus: result.httpStatus,
			durationMs: result.durationMs,
			redirectedTo: result.redirectedTo,
			bodyText: result.bodyText,
			Checks: result.checks,
		};
	}),
});

/** Checks pasted JSON with the same rules the probe applies to live responses. Pure computation, no outbound request. */
export const agentValidationValidatePost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: agentValidationValidateSchemaInput,
	output: agentValidationValidateSchemaOutput,
	handler: ({ input }: { input: z.infer<typeof agentValidationValidateSchemaInput> }) =>
		Promise.resolve({ Checks: validateJsonText(input.kind, input.json) }),
});

/** Computes a MIP-004 / MIP-003 hash and returns the exact string that was hashed. */
export const agentValidationHashPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: agentValidationHashSchemaInput,
	output: agentValidationHashSchemaOutput,
	handler: ({ input }: { input: z.infer<typeof agentValidationHashSchemaInput> }) => {
		const outcome = computeHash(input);
		if (!outcome.ok) throw createHttpError(400, outcome.message);
		return Promise.resolve({ hash: outcome.hash, preimage: outcome.preimage });
	},
});
