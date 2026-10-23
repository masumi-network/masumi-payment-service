import createHttpError from 'http-errors';
import { isIP, type LookupFunction } from 'node:net';
import {
	isBlockedIpAddress,
	isPrivateIpLiteral,
	resolveHostnameAddresses,
	stripHostnameBrackets,
	type ResolvedAddress,
} from '@masumi/payment-core/ssrf-guard';
import { getHydraPlaintextHosts } from '@/lib/hydra/hydra/node-url';

type HostDestinationDependencies = {
	trustedHosts?: string[];
	resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
};

const UNRESOLVABLE_HOST_MESSAGE = 'baseUrl hostname could not be resolved to a usable address';

const normalizeHostname = (hostname: string): string =>
	stripHostnameBrackets(hostname.trim().toLowerCase()).replace(/\.$/, '');

function hostDestinationPolicy(baseUrl: string, deps: HostDestinationDependencies) {
	const dnsHostname = stripHostnameBrackets(new URL(baseUrl).hostname);
	const hostname = normalizeHostname(dnsHostname);
	const trustedHosts = deps.trustedHosts ?? getHydraPlaintextHosts(process.env.HYDRA_TRUSTED_PRIVATE_HOSTS);
	const isTrusted = trustedHosts.some((trustedHost) => normalizeHostname(trustedHost) === hostname);
	const refuse = (): never => {
		throw createHttpError(
			400,
			'baseUrl is a private, loopback or link-local address; an operator must list the host in HYDRA_TRUSTED_PRIVATE_HOSTS to register a Host there',
		);
	};
	if (!isTrusted && isPrivateIpLiteral(hostname)) refuse();
	return { hostname, dnsHostname, isTrusted, refuse };
}

/**
 * Resolve a Hydra Host to the addresses the transport may connect to.
 *
 * Registering a Host makes the service call whatever the address names, with a
 * bearer token the caller chose, and report what came back. Pointed at loopback
 * that reached a hydra-node, which has no authentication of its own. An API key
 * with admin rights is not an infrastructure operator, so the exception cannot
 * be a flag on the request: it is the operator's list in
 * `HYDRA_TRUSTED_PRIVATE_HOSTS`, in the format of `HYDRA_TRUSTED_PLAINTEXT_HOSTS`.
 *
 * Every answer is checked, and the transport must use these answers instead
 * of resolving the hostname again. Failed or empty DNS answers are refused.
 */
export async function resolveAllowedHostDestination(
	baseUrl: string,
	deps: HostDestinationDependencies = {},
): Promise<ResolvedAddress[]> {
	const { hostname, dnsHostname, isTrusted, refuse } = hostDestinationPolicy(baseUrl, deps);

	let answers: ResolvedAddress[];
	const literalFamily = isIP(hostname);
	if (literalFamily === 4 || literalFamily === 6) {
		answers = [{ address: hostname, family: literalFamily }];
	} else {
		try {
			answers = await (deps.resolve ?? resolveHostnameAddresses)(dnsHostname);
		} catch {
			throw createHttpError(400, UNRESOLVABLE_HOST_MESSAGE);
		}
	}
	if (answers.length === 0) {
		throw createHttpError(400, UNRESOLVABLE_HOST_MESSAGE);
	}
	if (!isTrusted && answers.some(({ address, family }) => isBlockedIpAddress(address, family))) refuse();
	return answers;
}

export async function assertHostDestinationAllowed(
	baseUrl: string,
	deps: HostDestinationDependencies = {},
): Promise<void> {
	await resolveAllowedHostDestination(baseUrl, deps);
}

/** Recheck DNS for each socket. Literal IPs bypass Node's lookup callback. */
export function createHydraHostLookup(baseUrl: string, deps: HostDestinationDependencies = {}): LookupFunction {
	hostDestinationPolicy(baseUrl, deps);
	return (_hostname, options, callback) => {
		void resolveAllowedHostDestination(baseUrl, deps).then(
			(addresses) => {
				const candidates = options.family ? addresses.filter(({ family }) => family === options.family) : addresses;
				if (candidates.length === 0) {
					callback(createHttpError(400, UNRESOLVABLE_HOST_MESSAGE), '');
				} else if (options.all) {
					callback(null, candidates);
				} else {
					callback(null, candidates[0].address, candidates[0].family);
				}
			},
			(error: Error) => callback(error, ''),
		);
	};
}
