/**
 * Which peer addresses this Host lets a hydra-node dial.
 *
 * A peer's `host:port` arrives from a counterparty (an invite redemption) or
 * from the control plane, and becomes a `--peer` argument. Without a policy a
 * redeemer can name `127.0.0.1:8443` or `169.254.169.254:80` and make the node
 * open outbound peer-protocol connections into the Host's own network. So by
 * default every address the name resolves to must be globally routable.
 * Deployments that run peers on a private network opt out explicitly with
 * `HYDRA_HOST_ALLOW_PRIVATE_PEERS=true`.
 *
 * The name is resolved here, but hydra-node resolves it again on every
 * reconnect. A counterparty that controls its own DNS can pass this check with
 * a public record and serve a private one later (DNS rebinding). This check
 * closes literal addresses and names that resolve privately when configured.
 * Egress filtering on the node's network is the control for rebinding.
 */

import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { parsePeerAdvertise } from './peer-address.js';
import type { PeerHostnameResolver } from './api/peer-allowlist.js';

/** IANA special-purpose ranges that are not globally reachable. */
const NON_PUBLIC_IPV4: Array<[string, number]> = [
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
];

const NON_PUBLIC_IPV6: Array<[string, number]> = [
	['::', 96], // unspecified, loopback and IPv4-compatible
	['::ffff:0:0', 96], // IPv4-mapped: reaches the embedded IPv4 address
	['64:ff9b::', 96], // NAT64: reaches the embedded IPv4 address
	['64:ff9b:1::', 48],
	['100::', 64],
	['2001::', 23],
	['2001:db8::', 32],
	['2002::', 16], // 6to4: reaches the embedded IPv4 address
	['fc00::', 7],
	['fe80::', 10],
	['ff00::', 8],
];

// One list per family: a shared BlockList matches IPv4 addresses against the
// IPv4-mapped IPv6 rule above, which would block every IPv4 address.
const nonPublicIpv4 = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV4) nonPublicIpv4.addSubnet(network, prefix, 'ipv4');
const nonPublicIpv6 = new BlockList();
for (const [network, prefix] of NON_PUBLIC_IPV6) nonPublicIpv6.addSubnet(network, prefix, 'ipv6');

export function isPublicPeerIp(address: string): boolean {
	const family = isIP(address);
	if (family === 0) {
		return false;
	}
	return family === 4 ? !nonPublicIpv4.check(address, 'ipv4') : !nonPublicIpv6.check(address, 'ipv6');
}

/**
 * Why a peer may not be dialled.
 *
 * `transient` is true when the name could not be resolved (an error, no
 * records, or a timeout). Asking again later may succeed. A false value is a
 * policy decision that does not change by retrying.
 */
export type PeerTargetRejection = { reason: string; transient: boolean };

export type PeerTargetCheck = (advertise: string) => Promise<PeerTargetRejection | null>;

/**
 * Returns why `advertise` may not be dialled, or `null` when it may.
 *
 * A canonical IP literal is checked without a lookup. Other numeric forms,
 * such as `2130706433` or `0x7f.1`, go through the resolver: getaddrinfo
 * accepts them, and hydra-node resolves them the same way.
 */
export async function peerTargetRejection(
	advertise: string,
	options: { allowPrivate: boolean; resolve: PeerHostnameResolver },
): Promise<PeerTargetRejection | null> {
	const parsed = parsePeerAdvertise(advertise);
	if (parsed === null) {
		return { reason: `invalid peer advertise address: ${JSON.stringify(advertise)}`, transient: false };
	}
	if (options.allowPrivate) {
		return null;
	}

	let addresses: ReadonlyArray<{ address: string }>;
	if (isIP(parsed.host) !== 0) {
		addresses = [{ address: parsed.host }];
	} else {
		try {
			addresses = await options.resolve(parsed.host);
		} catch (error) {
			return { reason: `peer host ${parsed.host} does not resolve: ${(error as Error).message}`, transient: true };
		}
	}
	if (addresses.length === 0) {
		return { reason: `peer host ${parsed.host} does not resolve`, transient: true };
	}
	const blocked = addresses.find(({ address }) => !isPublicPeerIp(address));
	if (blocked !== undefined) {
		return {
			reason: `peer host ${parsed.host} resolves to non-public address ${blocked.address}; set HYDRA_HOST_ALLOW_PRIVATE_PEERS=true to allow private peers`,
			transient: false,
		};
	}
	return null;
}

/**
 * How long one peer name may take to resolve before it counts as unresolvable.
 *
 * getaddrinfo cannot be cancelled, so a lookup that times out still holds its
 * libuv thread until the system resolver gives up. The bound keeps callers from
 * waiting on it, and a timed-out name is refused, never allowed.
 */
export const PEER_LOOKUP_TIMEOUT_MS = 5_000;

export function withLookupTimeout(resolve: PeerHostnameResolver, timeoutMs: number): PeerHostnameResolver {
	return async (hostname) => {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`lookup timed out after ${timeoutMs}ms`)), timeoutMs);
		});
		try {
			return await Promise.race([resolve(hostname), timeout]);
		} finally {
			clearTimeout(timer);
		}
	};
}

/** The check the Host wires into every place a peer address is accepted or launched. */
export function createPeerTargetCheck(
	allowPrivate: boolean,
	resolve: PeerHostnameResolver = async (hostname) => await lookup(hostname, { all: true, verbatim: true }),
): PeerTargetCheck {
	const bounded = withLookupTimeout(resolve, PEER_LOOKUP_TIMEOUT_MS);
	return async (advertise) => await peerTargetRejection(advertise, { allowPrivate, resolve: bounded });
}
