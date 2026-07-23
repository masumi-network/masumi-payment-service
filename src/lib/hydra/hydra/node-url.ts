export type ValidatedHydraNodeUrls = {
	httpUrl: string;
	wsUrl: string;
};

export type HydraNodeUrlValidationOptions = {
	plaintextHosts?: Iterable<string>;
};

const MAX_NODE_URL_LENGTH = 2_048;

/**
 * Parse a persisted/user-supplied node URL pair at the trust boundary. Remote
 * endpoints require TLS unless their exact host is explicitly allowlisted.
 */
export function validateHydraNodeUrls(
	httpUrl: string,
	wsUrl: string,
	options: HydraNodeUrlValidationOptions = {},
): ValidatedHydraNodeUrls {
	const plaintextHosts = normalizePlaintextHosts(options.plaintextHosts);
	const parsedHttpUrl = parseHydraNodeUrl(httpUrl, ['http:', 'https:'], 'HTTP', plaintextHosts);
	const parsedWebSocketUrl = parseHydraNodeUrl(wsUrl, ['ws:', 'wss:'], 'WebSocket', plaintextHosts);

	if (parsedHttpUrl.hostname.toLowerCase() !== parsedWebSocketUrl.hostname.toLowerCase()) {
		throw new Error('Hydra HTTP and WebSocket URLs must use the same host');
	}
	if (effectivePort(parsedHttpUrl) !== effectivePort(parsedWebSocketUrl)) {
		throw new Error('Hydra HTTP and WebSocket URLs must use the same port');
	}
	if (parsedHttpUrl.pathname !== parsedWebSocketUrl.pathname) {
		throw new Error('Hydra HTTP and WebSocket URLs must use the same base path');
	}
	const httpIsSecure = parsedHttpUrl.protocol === 'https:';
	const webSocketIsSecure = parsedWebSocketUrl.protocol === 'wss:';
	if (httpIsSecure !== webSocketIsSecure) {
		throw new Error('Hydra HTTP and WebSocket URLs must use matching transport security');
	}

	return {
		httpUrl: normalizeBaseUrl(parsedHttpUrl),
		wsUrl: normalizeBaseUrl(parsedWebSocketUrl),
	};
}

export function validateHydraHttpUrl(httpUrl: string, options: HydraNodeUrlValidationOptions = {}): string {
	return normalizeBaseUrl(
		parseHydraNodeUrl(httpUrl, ['http:', 'https:'], 'HTTP', normalizePlaintextHosts(options.plaintextHosts)),
	);
}

export function getHydraPlaintextHosts(value = process.env.HYDRA_TRUSTED_PLAINTEXT_HOSTS): string[] {
	if (!value) return [];
	return value
		.split(',')
		.map((host) => normalizeHostname(host))
		.filter((host, index, hosts) => host.length > 0 && hosts.indexOf(host) === index);
}

export function buildHydraHttpEndpoint(baseUrl: string, endpoint: string): string {
	const parsed = new URL(`${baseUrl.replace(/\/+$/, '')}/`);
	parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/${endpoint.replace(/^\/+/, '')}`;
	return parsed.toString();
}

export function withHydraHistoryDisabled(baseUrl: string): string {
	const parsed = new URL(baseUrl);
	parsed.searchParams.set('history', 'no');
	return parsed.toString();
}

function parseHydraNodeUrl(value: string, allowedProtocols: string[], label: string, plaintextHosts: Set<string>): URL {
	if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NODE_URL_LENGTH || value.trim() !== value) {
		throw new Error(`Hydra ${label} URL is malformed`);
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`Hydra ${label} URL is malformed`);
	}
	if (!allowedProtocols.includes(parsed.protocol)) {
		throw new Error(`Hydra ${label} URL uses unsupported protocol ${parsed.protocol}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`Hydra ${label} URL must not contain credentials`);
	}
	if (parsed.hash || parsed.search) {
		throw new Error(`Hydra ${label} URL must not contain a query or fragment`);
	}
	if (!parsed.hostname) {
		throw new Error(`Hydra ${label} URL has no host`);
	}
	const hostname = normalizeHostname(parsed.hostname);
	const isPlaintext = parsed.protocol === 'http:' || parsed.protocol === 'ws:';
	if (isPlaintext && !isLoopbackHostname(hostname) && !plaintextHosts.has(hostname)) {
		throw new Error(
			`Hydra ${label} URL must use TLS outside loopback; explicitly allowlist trusted plaintext hosts with HYDRA_TRUSTED_PLAINTEXT_HOSTS`,
		);
	}
	return parsed;
}

function normalizePlaintextHosts(hosts: Iterable<string> | undefined): Set<string> {
	return new Set([...(hosts ?? [])].map((host) => normalizeHostname(host)).filter(Boolean));
}

function normalizeHostname(hostname: string): string {
	return hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '')
		.replace(/\.$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
	if (hostname === 'localhost' || hostname === '::1') return true;
	const octets = hostname.split('.');
	return (
		octets.length === 4 &&
		octets[0] === '127' &&
		octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) >= 0 && Number(octet) <= 255)
	);
}

function effectivePort(url: URL): string {
	if (url.port) return url.port;
	return url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80';
}

function normalizeBaseUrl(url: URL): string {
	const normalized = new URL(url.toString());
	normalized.pathname = normalized.pathname.replace(/\/+$/, '') || '/';
	return normalized.toString().replace(/\/$/, '');
}
