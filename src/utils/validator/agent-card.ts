import createHttpError from 'http-errors';
import { request, type RequestOptions } from 'node:https';
import { a2aProtocolVersionSchema } from './a2a-protocol-version';
import {
	resolveWebhookDestinationAllowed,
	type ResolvedAddress,
	isWebhookDestinationPolicyError,
} from '@/utils/security/webhook-destination-policy';
import { z } from '@masumi/payment-core/zod';

// One deadline covers DNS, connection attempts, and the response body.
// Pin checked addresses and stop reading once the byte limit is exceeded.
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
	protocolVersion: a2aProtocolVersionSchema,
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
		protocolVersions: z.array(a2aProtocolVersionSchema).min(1),
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
		const protocolVersions = new Set(card.protocolVersions);
		const interfaceVersions = new Set(card.supportedInterfaces.map((iface) => iface.protocolVersion));
		card.protocolVersions.forEach((version, index) => {
			if (!interfaceVersions.has(version)) {
				ctx.addIssue({
					code: 'custom',
					path: ['protocolVersions', index],
					message: `protocolVersion "${version}" has no supported interface`,
				});
			}
		});
		card.supportedInterfaces.forEach((iface, index) => {
			if (!protocolVersions.has(iface.protocolVersion)) {
				ctx.addIssue({
					code: 'custom',
					path: ['supportedInterfaces', index, 'protocolVersion'],
					message: `protocolVersion "${iface.protocolVersion}" is not listed in protocolVersions`,
				});
			}
		});
	});

export type AgentCard = z.infer<typeof agentCardSchema>;

async function resolveHttpsAgentCardUrl(rawUrl: string): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		throw createHttpError(400, 'A2A agent card URL is invalid');
	}
	if (parsedUrl.protocol !== 'https:') {
		throw createHttpError(400, 'A2A agent card URL must use https');
	}
	try {
		return await resolveWebhookDestinationAllowed(rawUrl);
	} catch (error) {
		if (isWebhookDestinationPolicyError(error)) {
			throw createHttpError(400, `A2A agent card URL rejected: ${error.reason}`);
		}
		throw error;
	}
}

function fetchAgentCardAtAddress(url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = request(
			url,
			{
				agent: false,
				signal,
				family: address.family,
				autoSelectFamily: false,
				// Resolve once. Keep the original URL host for TLS certificate checks and SNI.
				lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
				headers: { Accept: 'application/json', 'Accept-Encoding': 'identity' },
			} as RequestOptions & { autoSelectFamily: boolean },
			(response) => {
				void (async () => {
					try {
						const status = response.statusCode ?? 0;
						if (status < 200 || status >= 300) {
							throw createHttpError(400, `A2A agent card fetch failed with status ${status}`);
						}
						const contentType = response.headers['content-type'] ?? '';
						if (contentType.split(';')[0].trim().toLowerCase() !== 'application/json') {
							throw createHttpError(400, 'A2A agent card response was not application/json');
						}
						const contentLength = response.headers['content-length'];
						if (contentLength != null && Number(contentLength) > AGENT_CARD_MAX_BYTES) {
							throw createHttpError(400, 'A2A agent card response exceeds the maximum allowed size');
						}
						const chunks: Buffer[] = [];
						let bytes = 0;
						for await (const chunk of response) {
							const rawChunk: unknown = chunk;
							const buffer = rawChunk instanceof Uint8Array ? Buffer.from(rawChunk) : Buffer.from(String(rawChunk));
							bytes += buffer.length;
							if (bytes > AGENT_CARD_MAX_BYTES) {
								throw createHttpError(400, 'A2A agent card response exceeds the maximum allowed size');
							}
							chunks.push(buffer);
						}
						try {
							resolve(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')));
						} catch {
							throw createHttpError(400, 'A2A agent card response was not valid JSON');
						}
					} catch (error) {
						reject(error instanceof Error ? error : createHttpError(400, String(error)));
						response.destroy();
						req.destroy();
					}
				})();
			},
		);
		req.on('error', reject);
		req.end();
	});
}

async function fetchAgentCardJson(url: URL, addresses: ResolvedAddress[], signal: AbortSignal): Promise<unknown> {
	for (const [index, address] of addresses.entries()) {
		try {
			return await fetchAgentCardAtAddress(url, address, signal);
		} catch (error) {
			if (signal.aborted || createHttpError.isHttpError(error) || index === addresses.length - 1) {
				throw error;
			}
		}
	}
	throw createHttpError(400, 'A2A agent card hostname resolved to no addresses');
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
	const controller = new AbortController();
	let rejectDeadline: (error: Error) => void;
	const deadline = new Promise<never>((_resolve, reject) => {
		rejectDeadline = reject;
	});
	const timeout = setTimeout(() => {
		rejectDeadline(createHttpError(400, 'A2A agent card fetch timed out'));
		controller.abort();
	}, AGENT_CARD_FETCH_TIMEOUT_MS);
	timeout.unref();
	try {
		const destination = await Promise.race([resolveHttpsAgentCardUrl(agentCardUrl), deadline]);
		const json = await Promise.race([
			fetchAgentCardJson(destination.url, destination.addresses, controller.signal),
			deadline,
		]);
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
	} catch (error) {
		if (controller.signal.aborted) {
			throw createHttpError(400, 'A2A agent card fetch timed out');
		}
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
