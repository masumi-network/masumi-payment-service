import { BlockList, isIP } from 'node:net';
import { isPrivateIpLiteral } from '@masumi/payment-core/ssrf-guard';
import { DOCS, fail, pass, skipped, warn, type ValidationCheck, isJsonObject, type JsonObject } from './types';

/**
 * These rules deliberately mirror the registry service, because that is what decides
 * whether an agent shows up as Online:
 *   masumi-registry-service/src/services/health-check/health-check.service.ts (checkAndVerifyEndpoint)
 *   masumi-registry-service/src/utils/public-url/index.ts (normalizePublicUrl)
 * If the registry changes its health check, update both together.
 */

const REGISTRY_TIMEOUT_MS = 32_000;
const SLOW_RESPONSE_MS = 10_000;
const AGENT_TYPE = 'masumi-agent';
// Hostnames the registry rejects by name, on top of private IP ranges.
const BLOCKED_HOSTNAMES = new Set([
	'localhost',
	'localhost.localdomain',
	'ip6-localhost',
	'ip6-loopback',
	'metadata.google.internal',
]);

// The registry fetches with Node's fetch (undici), which refuses these ports ("bad port"). Same list as
// undici's lib/web/fetch/constants.js, so an agent on one of them shows up as Offline.
const BAD_PORTS = new Set(
	(
		'1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 ' +
		'123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 ' +
		'989 990 993 995 1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080'
	).split(' '),
);

// The registry's own address ranges (public-url/index.ts IPV4_RANGES / IPV6_RANGES). Two lists, so an IPv4
// address is never matched against the IPv4-mapped IPv6 rule.
const registryBlockedIpv4 = new BlockList();
for (const [network, prefix] of [
	['0.0.0.0', 8],
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.0.0', 24],
	['192.0.2.0', 24],
	['192.88.99.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
	['240.0.0.0', 4],
] as const) {
	registryBlockedIpv4.addSubnet(network, prefix, 'ipv4');
}
const registryBlockedIpv6 = new BlockList();
for (const [network, prefix] of [
	['::', 128],
	['::1', 128],
	['::ffff:0:0', 96],
	['100::', 64],
	['2001:2::', 48],
	['2001:db8::', 32],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
] as const) {
	registryBlockedIpv6.addSubnet(network, prefix, 'ipv6');
}

function isRegistryBlockedHost(rawHostname: string): boolean {
	// The registry lowercases, strips IPv6 brackets and one trailing dot before matching.
	const host = rawHostname
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
	if (BLOCKED_HOSTNAMES.has(host) || isPrivateIpLiteral(host)) return true;
	const family = isIP(host);
	if (family === 4) return registryBlockedIpv4.check(host, 'ipv4');
	if (family === 6) return registryBlockedIpv6.check(host, 'ipv6');
	return false;
}

/** Syntax-level URL rules. DNS resolution (hostnames that point at private IPs) is checked when probing. */
export function checkApiBaseUrl(rawInput: string): ValidationCheck[] {
	// The registry trims the registered value before validating it.
	const raw = rawInput.trim();
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return [
			fail('agent.url.valid', 'URL is a valid absolute http(s) URL', {
				detail: `"${raw}" is not an absolute URL.`,
				fix: 'Use the full base URL of your agent, e.g. https://my-agent.example.com',
				docsUrl: DOCS.registerAgent,
			}),
		];
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return [
			fail('agent.url.valid', 'URL is a valid absolute http(s) URL', {
				detail: `Protocol ${url.protocol} is not supported.`,
				fix: 'Use an http or https URL.',
				docsUrl: DOCS.registerAgent,
			}),
		];
	}

	const checks: ValidationCheck[] = [pass('agent.url.valid', 'URL is a valid absolute http(s) URL')];

	checks.push(
		url.protocol === 'https:'
			? pass('agent.url.https', 'URL uses https')
			: warn('agent.url.https', 'URL uses https', {
					detail: 'The agent is registered over plain http, so job input and results travel unencrypted.',
					fix: 'Serve the agent over https.',
				}),
	);

	checks.push(
		BAD_PORTS.has(url.port)
			? fail('agent.url.port', 'URL port is reachable by the registry', {
					detail: `Port ${url.port} is on the list of ports the registry's HTTP client refuses, so the registry marks the agent Offline.`,
					fix: 'Serve the agent on another port, for example 443, 8000 or 8080.',
					docsUrl: DOCS.registerAgent,
				})
			: pass('agent.url.port', 'URL port is reachable by the registry'),
	);

	const hasQueryOrFragment = url.search !== '' || url.hash !== '';
	const hasEmptyMarker = !hasQueryOrFragment && (raw.includes('?') || raw.includes('#'));
	checks.push(
		hasQueryOrFragment || hasEmptyMarker
			? fail('agent.url.no_query_or_fragment', 'URL has no query string or fragment', {
					detail: hasEmptyMarker
						? 'The URL contains an empty "?" or "#", so "/availability" would be appended inside the query or fragment and the agent would be probed at the wrong path.'
						: 'The registry marks URLs with a query string or fragment as Invalid.',
					fix: 'Register the base URL only, without ?… or #…',
					docsUrl: DOCS.registerAgent,
				})
			: pass('agent.url.no_query_or_fragment', 'URL has no query string or fragment'),
	);

	checks.push(
		isRegistryBlockedHost(url.hostname)
			? fail('agent.url.public_host', 'URL host is publicly reachable', {
					detail: `${url.hostname} is a local or private address, so the registry marks the agent Invalid.`,
					fix: 'Expose your agent publicly (a cloud deployment, or a tunnel such as ngrok) and register that URL.',
					docsUrl: DOCS.registerAgent,
				})
			: pass('agent.url.public_host', 'URL host is publicly reachable'),
	);

	return checks;
}

function redirectFix(location: string | null): string {
	if (location?.endsWith('/availability/')) {
		return 'Serve GET /availability directly without redirecting to the trailing-slash form (many frameworks have a "redirect slashes" option).';
	}
	if (location?.endsWith('/availability')) {
		return `Register the final URL (${location.replace(/\/availability$/, '')}) instead of the redirecting one.`;
	}
	return 'Serve GET /availability directly without redirecting, or register the URL it redirects to.';
}

/** What one GET {apiBaseUrl}/availability returned. `body` is undefined when it was not valid JSON. */
type AvailabilityObservation = {
	httpStatus: number | null;
	error: string | null;
	redirectedTo: string | null;
	durationMs: number;
	body: unknown;
};

type RegistryVerdict = { status: 'Online' | 'Offline' | 'Invalid'; reason: string };

function predictRegistryStatus(obs: AvailabilityObservation, expectedAgentIdentifier?: string): RegistryVerdict {
	if (obs.httpStatus == null) return { status: 'Offline', reason: obs.error ?? 'the request failed' };
	if (obs.redirectedTo != null) return { status: 'Offline', reason: 'the registry does not follow redirects' };
	if (obs.httpStatus < 200 || obs.httpStatus >= 300) return { status: 'Offline', reason: `HTTP ${obs.httpStatus}` };
	if (obs.body === undefined || obs.body === null)
		return { status: 'Offline', reason: 'the body is not a JSON object' };

	const body = isJsonObject(obs.body) ? obs.body : {};
	if (body.agentIdentifier) {
		if (expectedAgentIdentifier == null || body.agentIdentifier === expectedAgentIdentifier) {
			return { status: 'Online', reason: 'it returns an agentIdentifier that matches the registration' };
		}
		return { status: 'Invalid', reason: 'the returned agentIdentifier is not the registered one' };
	}
	return body.type === AGENT_TYPE
		? { status: 'Online', reason: `it reports type "${AGENT_TYPE}"` }
		: { status: 'Invalid', reason: `it does not report type "${AGENT_TYPE}"` };
}

/**
 * Evaluates the /availability answer the way the registry will, and adds the MIP-003 field checks.
 * `expectedAgentIdentifier` is the on-chain id once the agent is registered; before that it is undefined.
 */
export function checkAvailabilityResponse(
	obs: AvailabilityObservation,
	expectedAgentIdentifier?: string,
): ValidationCheck[] {
	const checks: ValidationCheck[] = [];
	const redirected = obs.redirectedTo != null;
	const isOk = obs.httpStatus != null && obs.httpStatus >= 200 && obs.httpStatus < 300;

	if (redirected) {
		checks.push(
			skipped('agent.availability.reachable', 'GET /availability answers with 2xx'),
			fail('agent.availability.no_redirect', 'GET /availability does not redirect', {
				detail: `Answered HTTP ${obs.httpStatus} redirecting to ${obs.redirectedTo}. The registry does not follow redirects, so it marks the agent Offline.`,
				fix: redirectFix(obs.redirectedTo),
				docsUrl: DOCS.registerAgent,
			}),
		);
	} else if (isOk) {
		checks.push(
			pass('agent.availability.reachable', 'GET /availability answers with 2xx'),
			pass('agent.availability.no_redirect', 'GET /availability does not redirect'),
		);
	} else {
		checks.push(
			fail('agent.availability.reachable', 'GET /availability answers with 2xx', {
				detail: obs.error ?? `Answered HTTP ${obs.httpStatus}.`,
				fix: `Make GET /availability return 200 within ${REGISTRY_TIMEOUT_MS / 1000}s. The registry marks the agent Offline otherwise.`,
				docsUrl: DOCS.agenticServiceApi,
			}),
		);
	}

	if (isOk) {
		const body = obs.body;
		if (body === undefined || body === null) {
			checks.push(
				fail('agent.availability.json', 'GET /availability returns a JSON object', {
					detail: 'The body was not valid JSON, so the registry marks the agent Offline.',
					fix: 'Return {"status":"available","type":"masumi-agent"} with Content-Type application/json.',
					docsUrl: DOCS.agenticServiceApi,
				}),
			);
		} else {
			checks.push(pass('agent.availability.json', 'GET /availability returns a JSON object'));
			checks.push(...checkAvailabilityFields(isJsonObject(body) ? body : {}, expectedAgentIdentifier));
		}
	}

	checks.push(
		obs.durationMs > SLOW_RESPONSE_MS
			? warn('agent.availability.speed', 'GET /availability answers quickly', {
					detail: `Took ${Math.round(obs.durationMs)} ms. The registry gives up after ${REGISTRY_TIMEOUT_MS / 1000}s.`,
					fix: 'Keep /availability free of heavy work; it is polled about every 100 seconds.',
				})
			: pass('agent.availability.speed', 'GET /availability answers quickly'),
	);

	const verdict = predictRegistryStatus(obs, expectedAgentIdentifier);
	checks.push(
		verdict.status === 'Online'
			? pass('agent.availability.registry_status', 'Registry will list this agent as Online', {
					detail: `Online: ${verdict.reason}.`,
				})
			: fail('agent.availability.registry_status', 'Registry will list this agent as Online', {
					detail: `${verdict.status}: ${verdict.reason}.`,
					fix: 'Fix the failed checks above, then re-run.',
					docsUrl: DOCS.registerAgent,
				}),
	);

	return checks;
}

function checkAvailabilityFields(body: JsonObject, expectedAgentIdentifier?: string): ValidationCheck[] {
	const checks: ValidationCheck[] = [];
	// The registry treats any truthy agentIdentifier as an id, so a non-string one is shown as JSON.
	const rawId = body.agentIdentifier;
	const returnedId = rawId ? (typeof rawId === 'string' ? rawId : JSON.stringify(rawId)) : null;

	if (body.type === AGENT_TYPE) {
		checks.push(pass('agent.availability.type', `Reports type "${AGENT_TYPE}"`));
	} else if (returnedId != null) {
		checks.push(
			warn('agent.availability.type', `Reports type "${AGENT_TYPE}"`, {
				detail: `type is ${JSON.stringify(body.type) ?? 'missing'}. The registry accepts the agent only because it returns an agentIdentifier.`,
				fix: `MIP-003 requires "type":"${AGENT_TYPE}".`,
				docsUrl: DOCS.agenticServiceApi,
			}),
		);
	} else {
		checks.push(
			fail('agent.availability.type', `Reports type "${AGENT_TYPE}"`, {
				detail: `type is ${JSON.stringify(body.type) ?? 'missing'}, so the registry marks the agent Invalid.`,
				fix: `Return {"type":"${AGENT_TYPE}"} from GET /availability.`,
				docsUrl: DOCS.agenticServiceApi,
			}),
		);
	}

	if (returnedId != null) {
		if (expectedAgentIdentifier == null) {
			checks.push(
				skipped('agent.availability.agent_identifier', 'Returned agentIdentifier matches the registration', {
					detail: `Returned "${returnedId}". It is compared with the on-chain id once the agent is registered.`,
				}),
			);
		} else if (returnedId === expectedAgentIdentifier) {
			checks.push(pass('agent.availability.agent_identifier', 'Returned agentIdentifier matches the registration'));
		} else {
			checks.push(
				fail('agent.availability.agent_identifier', 'Returned agentIdentifier matches the registration', {
					detail: `Returned "${returnedId}", registered as "${expectedAgentIdentifier}". The registry marks the agent Invalid.`,
					fix: 'Return the agent identifier shown in the registry, or remove the field.',
					docsUrl: DOCS.registerAgent,
				}),
			);
		}
	}

	if (body.status === 'available') {
		checks.push(pass('agent.availability.status_field', 'Reports status "available"'));
	} else {
		checks.push(
			warn('agent.availability.status_field', 'Reports status "available"', {
				detail: `status is ${JSON.stringify(body.status) ?? 'missing'}. The registry ignores this field, but buyers treat anything but "available" as down.`,
				fix: 'Return {"status":"available"} while the agent can take jobs.',
				docsUrl: DOCS.agenticServiceApi,
			}),
		);
	}

	return checks;
}
