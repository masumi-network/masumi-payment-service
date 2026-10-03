/**
 * Parse the public `host:port` identity used by hydra-node and nftables.
 *
 * This grammar is deliberately narrower than a URL. The value is passed to
 * hydra-node as one argv element and its host is rendered into an nftables
 * address set, so whitespace and configuration-language punctuation must never
 * cross this boundary.
 */

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/;
const HOST_PORT_PATTERN = /^([^:]+):(\d{1,5})$/;

export type PeerAdvertiseAddress = {
	host: string;
	port: number;
};

export function isPeerHostname(value: string): boolean {
	return HOST_PATTERN.test(value);
}

export function parsePeerAdvertise(value: string): PeerAdvertiseAddress | null {
	const match = HOST_PORT_PATTERN.exec(value);
	if (match === null || !isPeerHostname(match[1])) {
		return null;
	}

	const port = Number(match[2]);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		return null;
	}

	return { host: match[1], port };
}
