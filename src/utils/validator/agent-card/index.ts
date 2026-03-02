import { z } from '@/utils/zod-openapi';
import createHttpError from 'http-errors';
import { logger } from '@/utils/logger';
import { timedFetch } from '@/utils/timed-fetch';
import net from 'net';

function isPrivateIp(ip: string): boolean {
	if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') return true;
	const parts = ip.split('.').map(Number);
	if (parts.length !== 4) return false;
	const [a, b] = parts;
	return (
		a === 127 || // 127.x.x.x loopback
		a === 10 || // 10.x.x.x private
		(a === 172 && b >= 16 && b <= 31) || // 172.16-31.x.x private
		(a === 192 && b === 168) || // 192.168.x.x private
		(a === 169 && b === 254) || // 169.254.x.x link-local / cloud metadata
		a === 0 || // 0.x.x.x
		(a === 100 && b >= 64 && b <= 127) // 100.64-127.x.x shared address space
	);
}

function assertPublicHttpsUrl(rawUrl: string): void {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		throw createHttpError(400, 'Invalid agent card URL');
	}
	if (parsed.protocol !== 'https:') {
		throw createHttpError(400, 'Agent card URL must use HTTPS');
	}
	const host = parsed.hostname.toLowerCase();
	if (host === 'localhost' || host.endsWith('.localhost')) {
		throw createHttpError(400, 'Agent card URL must not point to a private or internal host');
	}
	if (net.isIP(host) !== 0 && isPrivateIp(host)) {
		throw createHttpError(400, 'Agent card URL must not point to a private or internal host');
	}
}

export const agentCardSchema = z.object({
	protocolVersions: z.array(z.string().min(1)).min(1),
	name: z.string(),
	description: z.string(),
	version: z.string(),
	supportedInterfaces: z
		.array(
			z.object({
				url: z
					.string()
					.url()
					.refine((u) => u.startsWith('https://'), { message: 'Interface URL must use HTTPS' }),
				protocolBinding: z.string(),
				protocolVersion: z.string(),
			}),
		)
		.min(1),
	provider: z
		.object({
			organization: z.string().optional(),
			url: z.string().optional(),
		})
		.optional(),
	documentationUrl: z.string().optional(),
	iconUrl: z.string().optional(),
	capabilities: z
		.object({
			streaming: z.boolean().optional(),
			pushNotifications: z.boolean().optional(),
			extensions: z
				.array(
					z.object({
						uri: z.string(),
						description: z.string().optional(),
						required: z.boolean().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
	defaultInputModes: z.array(z.string()),
	defaultOutputModes: z.array(z.string()),
	skills: z
		.array(
			z.object({
				id: z.string(),
				name: z.string(),
				description: z.string(),
				tags: z.array(z.string()),
				examples: z.array(z.string()).optional(),
				inputModes: z.array(z.string()),
				outputModes: z.array(z.string()),
			}),
		)
		.min(1),
});

export type AgentCard = z.infer<typeof agentCardSchema>;

export async function fetchAndValidateAgentCard(
	agentCardUrl: string,
	a2aProtocolVersions: string[],
): Promise<AgentCard> {
	assertPublicHttpsUrl(agentCardUrl);

	let response: Response;
	try {
		response = await timedFetch(agentCardUrl);
	} catch (error) {
		logger.error('Failed to fetch agent card', { url: agentCardUrl, error });
		throw createHttpError(
			400,
			`Failed to fetch agent card from ${agentCardUrl}: ${error instanceof Error ? error.message : 'Unknown error'}`,
		);
	}

	if (!response.ok) {
		throw createHttpError(400, `Agent card URL returned HTTP ${response.status}`);
	}

	let json: unknown;
	try {
		json = await response.json();
	} catch {
		throw createHttpError(400, 'Agent card URL did not return valid JSON');
	}

	const parsed = agentCardSchema.safeParse(json);
	if (!parsed.success) {
		const zodIssues = parsed.error.issues;
		logger.error('Agent card validation failed', { url: agentCardUrl, errors: zodIssues });
		throw createHttpError(
			400,
			`Agent card validation failed: ${zodIssues.map((e) => `${e.path.map(String).join('.')}: ${e.message}`).join(', ')}`,
		);
	}

	const cardVersionSet = new Set(parsed.data.protocolVersions);

	// Each supportedInterface must reference a version declared in protocolVersions
	const invalidInterfaceVersions = parsed.data.supportedInterfaces
		.map((iface, i) => ({ i, version: iface.protocolVersion }))
		.filter(({ version }) => !cardVersionSet.has(version));
	if (invalidInterfaceVersions.length > 0) {
		const details = invalidInterfaceVersions
			.map(({ i, version }) => `supportedInterfaces[${i}].protocolVersion "${version}"`)
			.join(', ');
		throw createHttpError(
			400,
			`Agent card validation failed: ${details} not found in protocolVersions [${parsed.data.protocolVersions.join(', ')}]`,
		);
	}

	// All requested a2aProtocolVersions must be declared in the Agent Card
	const mismatched = a2aProtocolVersions.filter((v) => !cardVersionSet.has(v));
	if (mismatched.length > 0) {
		throw createHttpError(
			400,
			`a2aProtocolVersions mismatch: [${mismatched.join(', ')}] not in Agent Card protocolVersions [${parsed.data.protocolVersions.join(', ')}]`,
		);
	}

	return parsed.data;
}
