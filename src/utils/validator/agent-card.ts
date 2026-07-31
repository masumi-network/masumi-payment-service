import createHttpError from 'http-errors';
import {
	assertWebhookDestinationAllowed,
	isWebhookDestinationPolicyError,
} from '@/utils/security/webhook-destination-policy';
import { z } from '@masumi/payment-core/zod';

// Bounded fetch guards, matching the pattern in
// packages/payment-source-x402/src/remote-facilitator.ts: an AbortController
// timeout so a slow/hanging agent-card host cannot stall a registration
// request indefinitely, plus a hard cap on response size so a malicious host
// cannot exhaust memory with an oversized body.
export const AGENT_CARD_FETCH_TIMEOUT_MS = 10_000;
export const AGENT_CARD_MAX_BYTES = 1_048_576; // 1 MB

// MIP-002-A2A Agent Card schema. Field names and required/optional split are
// taken verbatim from the spec (https://github.com/masumi-network/masumi-improvement-proposals/blob/main/MIPs/MIP-002/MIP-002-A2A.md),
// not paraphrased. `.superRefine` enforces the spec's cross-field rule that
// every supportedInterfaces[].protocolVersion must appear in the top-level
// protocolVersions list.
const agentCardInterfaceSchema = z.object({
	url: z
		.string()
		.url()
		.refine((url) => url.startsWith('https://'), 'supportedInterfaces[].url must be HTTPS'),
	protocolBinding: z.enum(['HTTP+JSON', 'JSONRPC', 'GRPC']),
	protocolVersion: z.string(),
});

const agentCardSkillSchema = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string(),
	tags: z.array(z.string()),
	inputModes: z.array(z.string()),
	outputModes: z.array(z.string()),
	examples: z.array(z.string()).optional(),
});

const agentCardExtensionSchema = z.object({
	uri: z.string().optional(),
	description: z.string().optional(),
	required: z.boolean().optional(),
});

const agentCardCapabilitiesSchema = z
	.object({
		streaming: z.boolean().optional(),
		pushNotifications: z.boolean().optional(),
		extensions: z.array(agentCardExtensionSchema).optional(),
	})
	.passthrough();

export const agentCardSchema = z
	.object({
		protocolVersions: z.array(z.string()).min(1),
		name: z.string(),
		description: z.string(),
		version: z.string(),
		supportedInterfaces: z.array(agentCardInterfaceSchema).min(1),
		capabilities: agentCardCapabilitiesSchema,
		defaultInputModes: z.array(z.string()),
		defaultOutputModes: z.array(z.string()),
		skills: z.array(agentCardSkillSchema).min(1),
		provider: z
			.object({
				organization: z.string().optional(),
				url: z.string().optional(),
			})
			.optional(),
		documentationUrl: z.string().optional(),
		iconUrl: z.string().optional(),
	})
	.passthrough()
	.superRefine((card, ctx) => {
		card.supportedInterfaces.forEach((iface, index) => {
			if (!card.protocolVersions.includes(iface.protocolVersion)) {
				ctx.addIssue({
					code: 'custom',
					path: ['supportedInterfaces', index, 'protocolVersion'],
					message: `protocolVersion "${iface.protocolVersion}" is not listed in protocolVersions`,
				});
			}
		});
	});

export type AgentCard = z.infer<typeof agentCardSchema>;

// Reuses the hardened, DNS-resolving SSRF guard already used for webhook
// delivery (RFC1918/CGNAT/loopback/link-local blocklist). That guard allows
// both http/https; MIP-002 requires HTTPS for the agent card itself, so the
// stricter protocol check is layered on top here rather than modifying the
// shared function (its only other caller, webhook delivery, legitimately
// allows http).
async function assertHttpsAgentCardUrl(rawUrl: string): Promise<URL> {
	// Cheap, synchronous protocol check first — reject non-https before paying
	// for a DNS-resolving SSRF check that would only be discarded afterwards.
	let protocolCheckUrl: URL;
	try {
		protocolCheckUrl = new URL(rawUrl);
	} catch {
		throw createHttpError(400, 'A2A agent card URL is invalid');
	}
	if (protocolCheckUrl.protocol !== 'https:') {
		throw createHttpError(400, 'A2A agent card URL must use https');
	}
	try {
		return await assertWebhookDestinationAllowed(rawUrl);
	} catch (error) {
		if (isWebhookDestinationPolicyError(error)) {
			throw createHttpError(400, `A2A agent card URL rejected: ${error.reason}`);
		}
		throw error;
	}
}

async function fetchAgentCardJson(url: URL): Promise<unknown> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), AGENT_CARD_FETCH_TIMEOUT_MS);
	timeout.unref();
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			// Do not let a public agent-card host redirect around the SSRF guard
			// that already validated `url` above.
			redirect: 'error',
		});
		if (!response.ok) {
			throw createHttpError(400, `A2A agent card fetch failed with status ${response.status}`);
		}
		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.includes('application/json')) {
			throw createHttpError(400, 'A2A agent card response was not application/json');
		}
		const contentLength = response.headers.get('content-length');
		if (contentLength != null && Number(contentLength) > AGENT_CARD_MAX_BYTES) {
			throw createHttpError(400, 'A2A agent card response exceeds the maximum allowed size');
		}
		const text = await response.text();
		if (text.length > AGENT_CARD_MAX_BYTES) {
			throw createHttpError(400, 'A2A agent card response exceeds the maximum allowed size');
		}
		try {
			return JSON.parse(text);
		} catch {
			throw createHttpError(400, 'A2A agent card response was not valid JSON');
		}
	} catch (error) {
		if (controller.signal.aborted) {
			throw createHttpError(400, 'A2A agent card fetch timed out');
		}
		// A createHttpError we already threw above (bad status/content-type/size/JSON)
		// passes through unwrapped; anything else — a raw network failure (DNS,
		// connection refused, TLS, or a rejected redirect from `redirect: 'error'`) —
		// must not escape as an unhandled 500.
		if (createHttpError.isHttpError(error)) {
			throw error;
		}
		throw createHttpError(
			400,
			`Could not fetch A2A agent card: ${error instanceof Error ? error.message : String(error)}`,
		);
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * Fetches and validates a MIP-002 Agent Card before registration. Throws an
 * `http-errors` 400 for every failure mode (blocked/non-https URL, timeout,
 * non-JSON, oversized body, schema-invalid, declared protocol version absent
 * from the card) — never lets a raw fetch/DNS error escape as a 500.
 *
 * `declaredProtocolVersions` are the versions the registrant claims this
 * agent supports (persisted as `RegistryRequest.a2aProtocolVersions`); every
 * declared version must actually appear in the fetched card's
 * `protocolVersions` so the on-chain claim matches what the agent publishes.
 */
export async function validateA2AAgentCardOrThrow(
	agentCardUrl: string,
	declaredProtocolVersions: string[],
): Promise<void> {
	const parsedUrl = await assertHttpsAgentCardUrl(agentCardUrl);
	const json = await fetchAgentCardJson(parsedUrl);
	const parseResult = agentCardSchema.safeParse(json);
	if (!parseResult.success) {
		throw createHttpError(400, `A2A agent card is invalid: ${parseResult.error.message}`);
	}
	const card = parseResult.data;
	const missingVersions = declaredProtocolVersions.filter((version) => !card.protocolVersions.includes(version));
	if (missingVersions.length > 0) {
		throw createHttpError(
			400,
			`A2A agent card does not support declared protocol version(s): ${missingVersions.join(', ')}`,
		);
	}
}
