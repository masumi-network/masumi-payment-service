import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const WEBHOOK_DESTINATION_NOT_ALLOWED_MESSAGE = 'Webhook destination is not allowed';
export const WEBHOOK_DELIVERY_BLOCKED_MESSAGE = 'Delivery blocked by policy';

type IpFamily = 4 | 6;

type ResolvedAddress = {
	address: string;
	family: IpFamily;
};

const blockedAddressList = new BlockList();

const blockedIpv4Subnets: Array<[string, number]> = [
	['10.0.0.0', 8],
	['100.64.0.0', 10],
	['127.0.0.0', 8],
	['169.254.0.0', 16],
	['172.16.0.0', 12],
	['192.0.2.0', 24],
	['192.168.0.0', 16],
	['198.18.0.0', 15],
	['198.51.100.0', 24],
	['203.0.113.0', 24],
	['224.0.0.0', 4],
];

const blockedIpv6Subnets: Array<[string, number]> = [
	['2001:db8::', 32],
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
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

export class WebhookDestinationPolicyError extends Error {
	constructor(public readonly reason: string) {
		super(reason);
		this.name = 'WebhookDestinationPolicyError';
	}
}

export const isWebhookDestinationPolicyError = (error: unknown): error is WebhookDestinationPolicyError =>
	error instanceof WebhookDestinationPolicyError;

const getMappedIpv4 = (address: string): string | null => {
	const mappedPrefix = '::ffff:';
	if (!address.toLowerCase().startsWith(mappedPrefix) || !address.includes('.')) {
		return null;
	}

	return address.slice(mappedPrefix.length);
};

const normalizeHostname = (hostname: string): string =>
	hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

const resolveHostname = async (hostname: string): Promise<ResolvedAddress[]> => {
	const normalizedHostname = normalizeHostname(hostname);
	const literalFamily = isIP(normalizedHostname);
	if (literalFamily === 4 || literalFamily === 6) {
		return [{ address: normalizedHostname, family: literalFamily }];
	}

	const addresses = await lookup(normalizedHostname, { all: true, verbatim: true });
	if (addresses.length === 0) {
		throw new WebhookDestinationPolicyError('Destination hostname resolved to no addresses');
	}

	const resolvedAddresses = addresses.filter(
		(result): result is ResolvedAddress => result.family === 4 || result.family === 6,
	);
	if (resolvedAddresses.length === 0) {
		throw new WebhookDestinationPolicyError('Destination hostname resolved to unsupported address families');
	}

	return resolvedAddresses;
};

const isBlockedAddress = ({ address, family }: ResolvedAddress): boolean => {
	if (family === 6) {
		const mappedIpv4 = getMappedIpv4(address);
		if (mappedIpv4 != null) {
			return blockedAddressList.check(mappedIpv4, 'ipv4');
		}
	}

	return blockedAddressList.check(address, family === 4 ? 'ipv4' : 'ipv6');
};

export const assertWebhookDestinationAllowed = async (rawUrl: string): Promise<URL> => {
	let parsedUrl: URL;
	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		throw new WebhookDestinationPolicyError('Webhook destination URL is invalid');
	}

	if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
		throw new WebhookDestinationPolicyError('Webhook destinations must use http or https');
	}

	if (parsedUrl.hostname.length === 0) {
		throw new WebhookDestinationPolicyError('Webhook destination host is required');
	}

	if (parsedUrl.username.length > 0 || parsedUrl.password.length > 0) {
		throw new WebhookDestinationPolicyError('Webhook destinations must not contain userinfo');
	}

	let resolvedAddresses: ResolvedAddress[];
	try {
		resolvedAddresses = await resolveHostname(parsedUrl.hostname);
	} catch (error) {
		if (isWebhookDestinationPolicyError(error)) {
			throw error;
		}
		throw new WebhookDestinationPolicyError('Webhook destination could not be resolved');
	}

	if (resolvedAddresses.some(isBlockedAddress)) {
		throw new WebhookDestinationPolicyError('Webhook destination resolved to a blocked address');
	}

	return parsedUrl;
};

export const redactWebhookDestination = (rawUrl: string): string => {
	const suffix = createHash('sha256').update(rawUrl).digest('hex').slice(0, 8);

	try {
		const parsedUrl = new URL(rawUrl);
		return `${parsedUrl.protocol}//${parsedUrl.host}#${suffix}`;
	} catch {
		return `invalid-url#${suffix}`;
	}
};
