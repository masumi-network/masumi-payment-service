import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';


export type IpFamily = 4 | 6;

export type ResolvedAddress = {
	address: string;
	family: IpFamily;
};

export class UnresolvableHostnameError extends Error {
	constructor(reason: string) {
		super(reason);
		this.name = 'UnresolvableHostnameError';
	}
}

export const isUnresolvableHostnameError = (error: unknown): error is UnresolvableHostnameError =>
	error instanceof UnresolvableHostnameError;

const blockedAddressList = new BlockList();

const blockedIpv4Subnets: Array<[string, number]> = [
	['10.0.0.0', 8],
	['100.64.0.0', 10], // CGNAT
	['127.0.0.0', 8], // loopback
	['169.254.0.0', 16], // link-local, incl. cloud metadata (169.254.169.254)
	['172.16.0.0', 12],
	['192.0.2.0', 24], // TEST-NET-1
	['192.168.0.0', 16],
	['198.18.0.0', 15], // benchmarking
	['198.51.100.0', 24], // TEST-NET-2
	['203.0.113.0', 24], // TEST-NET-3
	['224.0.0.0', 4], // multicast+
];

const blockedIpv6Subnets: Array<[string, number]> = [
	['2001:db8::', 32], // documentation
	['fc00::', 7], // unique-local
	['fe80::', 10], // link-local
	['ff00::', 8], // multicast
];

for (const [network, prefix] of blockedIpv4Subnets) {
	blockedAddressList.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of blockedIpv6Subnets) {
	blockedAddressList.addSubnet(network, prefix, 'ipv6');
}
blockedAddressList.addAddress('0.0.0.0', 'ipv4');
blockedAddressList.addAddress('::', 'ipv6');
blockedAddressList.addAddress('::1', 'ipv6');

export const stripHostnameBrackets = (hostname: string): string =>
	hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

const isLocalhostName = (hostname: string): boolean => hostname === 'localhost' || hostname.endsWith('.localhost');

export const isBlockedIpAddress = (address: string, family: IpFamily): boolean =>
	blockedAddressList.check(address, family === 4 ? 'ipv4' : 'ipv6');


export const isPrivateIpLiteral = (hostname: string): boolean => {
	const host = stripHostnameBrackets(hostname).toLowerCase();
	if (isLocalhostName(host)) return true;
	const family = isIP(host);
	return (family === 4 || family === 6) && isBlockedIpAddress(host, family);
};

export const resolveHostnameAddresses = async (hostname: string): Promise<ResolvedAddress[]> => {
	const host = stripHostnameBrackets(hostname).toLowerCase();
	const literalFamily = isIP(host);
	if (literalFamily === 4 || literalFamily === 6) {
		return [{ address: host, family: literalFamily }];
	}

	const addresses = await lookup(host, { all: true, verbatim: true });
	if (addresses.length === 0) {
		throw new UnresolvableHostnameError('Hostname resolved to no addresses');
	}

	const resolvedAddresses = addresses.filter(
		(result): result is ResolvedAddress => result.family === 4 || result.family === 6,
	);
	if (resolvedAddresses.length === 0) {
		throw new UnresolvableHostnameError('Hostname resolved to unsupported address families');
	}

	return resolvedAddresses;
};


export const isPrivateOrUnresolvableHostname = async (hostname: string): Promise<boolean> => {
	const host = stripHostnameBrackets(hostname).toLowerCase();
	if (isLocalhostName(host)) return true;
	try {
		const resolved = await resolveHostnameAddresses(host);
		return resolved.some(({ address, family }) => isBlockedIpAddress(address, family));
	} catch {
		return true;
	}
};
