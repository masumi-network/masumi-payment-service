import createHttpError from 'http-errors';
import {
	isBlockedIpAddress,
	isPrivateIpLiteral,
	resolveHostnameAddresses,
	stripHostnameBrackets,
	type ResolvedAddress,
} from '@masumi/payment-core/ssrf-guard';
import { getHydraPlaintextHosts } from '@/lib/hydra/hydra/node-url';

/**
 * Whether the service may be pointed at this address as a Hydra Host.
 *
 * Registering a Host makes the service call whatever the address names, with a
 * bearer token the caller chose, and report what came back. Pointed at loopback
 * that reached a hydra-node, which has no authentication of its own. An API key
 * with admin rights is not an infrastructure operator, so the exception cannot
 * be a flag on the request: it is the operator's list in
 * `HYDRA_TRUSTED_PRIVATE_HOSTS`, in the format of `HYDRA_TRUSTED_PLAINTEXT_HOSTS`.
 *
 * Every answer a name resolves to is checked: taking only the public member of a
 * mixed set would leave the rest to whichever the resolver returns at connect
 * time. A name that resolves to nothing passes, because nothing can connect to
 * it and the probe reports the Host unreachable.
 *
 * Checked when a Host is registered. A name that resolves to a public address
 * then and to a private one later is not caught here; closing that needs the
 * address pinned at connect time.
 */
export async function assertHostDestinationAllowed(
	baseUrl: string,
	deps: {
		trustedHosts?: string[];
		resolve?: (hostname: string) => Promise<ResolvedAddress[]>;
	} = {},
): Promise<void> {
	const hostname = stripHostnameBrackets(new URL(baseUrl).hostname);
	const trustedHosts = deps.trustedHosts ?? getHydraPlaintextHosts(process.env.HYDRA_TRUSTED_PRIVATE_HOSTS);
	if (trustedHosts.includes(hostname)) return;

	const refuse = (): never => {
		throw createHttpError(
			400,
			'baseUrl is a private, loopback or link-local address; an operator must list the host in HYDRA_TRUSTED_PRIVATE_HOSTS to register a Host there',
		);
	};
	if (isPrivateIpLiteral(hostname)) refuse();

	let answers: ResolvedAddress[];
	try {
		answers = await (deps.resolve ?? resolveHostnameAddresses)(hostname);
	} catch {
		return;
	}
	if (answers.some(({ address, family }) => isBlockedIpAddress(address, family))) refuse();
}
