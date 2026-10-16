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

export type PeerTargetCheck = (advertise: string) => Promise<string | null>;

/**
 * Returns why `advertise` may not be dialled, or `null` when it may.
 *
 * IP literals go through the resolver as well: getaddrinfo also accepts forms
 * such as `2130706433` or `0x7f.1`, and hydra-node resolves them the same way.
 */
export async function peerTargetRejection(
	advertise: string,
	options: { allowPrivate: boolean; resolve: PeerHostnameResolver },
): Promise<string | null> {
	const parsed = parsePeerAdvertise(advertise);
	if (parsed === null) {
		return `invalid peer advertise address: ${JSON.stringify(advertise)}`;
	}
	if (options.allowPrivate) {
		return null;
	}

	let addresses: ReadonlyArray<{ address: string }>;
	try {
		addresses = await options.resolve(parsed.host);
	} catch (error) {
		return `peer host ${parsed.host} does not resolve: ${(error as Error).message}`;
	}
	if (addresses.length === 0) {
		return `peer host ${parsed.host} does not resolve`;
	}
	const blocked = addresses.find(({ address }) => !isPublicPeerIp(address));
	if (blocked !== undefined) {
		return `peer host ${parsed.host} resolves to non-public address ${blocked.address}; set HYDRA_HOST_ALLOW_PRIVATE_PEERS=true to allow private peers`;
	}
	return null;
}
