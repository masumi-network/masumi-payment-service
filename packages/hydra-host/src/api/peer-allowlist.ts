/**
 * Which hosts may reach which peer port.
 *
 * The peer plane is the one Hydra surface that cannot authenticate its callers:
 * it carries etcd raft, so there is no token to present and no handshake to
 * gate. ADR 0010 §1 therefore protects it with a per-head IP allow-list, which
 * costs nothing because a counterparty's address must already be known to set
 * `--peer`.
 *
 * This module derives that allow-list from what the Host already knows. It
 * emits the rules rather than applying them, because the container cannot alter
 * the host firewall it is running behind and should not try. The operator (or
 * the platform) applies them and re-applies whenever DNS or membership changes.
 *
 * Configured peer names are never interpolated into nftables syntax. They are
 * resolved first, and the renderer independently accepts IPv4 literals only.
 * This keeps a syntactically valid hostname such as an nftables address range
 * from changing the meaning of the generated ruleset.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { NodeRecord } from '../registry/types.js';
import { isPeerHostname, parsePeerAdvertise } from '../peer-address.js';

export type PeerAllowRule = {
	nodeId: string;
	/** The port this node listens on for raft traffic. */
	peerPort: number;
	/** Hosts permitted to reach it, taken from each peer's advertise address. */
	allowedHosts: string[];
	/**
	 * True when the node has no peers yet, which means the port must stay shut.
	 * A provisioned-but-unpeered node is the window in which an open peer port
	 * protects nothing at all.
	 */
	closed: boolean;
};

export type PeerAllowlist = {
	rules: PeerAllowRule[];
	/** Ports in the configured peer range with no node on them. */
	unusedPorts: number[];
};

export type ResolvedPeerAllowRule = PeerAllowRule & {
	/** Canonical IPv4 literals safe to render in an `ip saddr` set. */
	allowedIpv4Addresses: string[];
	/** Names that failed or resolved only to unsupported address families. */
	resolutionErrors: Array<{ host: string; reason: string }>;
};

export type ResolvedPeerAllowlist = Omit<PeerAllowlist, 'rules'> & {
	rules: ResolvedPeerAllowRule[];
};

export type PeerHostnameResolver = (hostname: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;

const defaultResolver: PeerHostnameResolver = async (hostname) => await lookup(hostname, { all: true, verbatim: true });

/** Strip the `:port` from an advertise address, leaving the host. */
export function hostOfAdvertise(advertise: string): string {
	const parsed = parsePeerAdvertise(advertise);
	if (parsed !== null) {
		return parsed.host;
	}
	if (isPeerHostname(advertise)) {
		return advertise;
	}
	throw new Error(`invalid peer advertise address: ${JSON.stringify(advertise)}`);
}

export function buildPeerAllowlist(records: NodeRecord[], peerRange: { start: number; count: number }): PeerAllowlist {
	const rules = records
		.map((record) => {
			const allowedHosts = [...new Set(record.peers.map((peer) => hostOfAdvertise(peer.advertise)))].sort();
			return {
				nodeId: record.nodeId,
				peerPort: record.peerPort,
				allowedHosts,
				closed: allowedHosts.length === 0,
			};
		})
		.sort((a, b) => a.peerPort - b.peerPort);

	const used = new Set(rules.map((rule) => rule.peerPort));
	const unusedPorts: number[] = [];
	for (let port = peerRange.start; port < peerRange.start + peerRange.count; port += 1) {
		if (!used.has(port)) {
			unusedPorts.push(port);
		}
	}

	return { rules, unusedPorts };
}

/** Resolve configured peer names without ever passing those names to nftables. */
export async function resolvePeerAllowlist(
	allowlist: PeerAllowlist,
	resolve: PeerHostnameResolver = defaultResolver,
): Promise<ResolvedPeerAllowlist> {
	const rules = await Promise.all(
		allowlist.rules.map(async (rule): Promise<ResolvedPeerAllowRule> => {
			const addresses = new Set<string>();
			const resolutionErrors: Array<{ host: string; reason: string }> = [];

			for (const host of rule.allowedHosts) {
				if (isIP(host) === 4) {
					addresses.add(host);
					continue;
				}

				try {
					const results = await resolve(host);
					const ipv4 = results.map((entry) => entry.address).filter((address) => isIP(address) === 4);
					if (ipv4.length === 0) {
						resolutionErrors.push({ host, reason: 'did not resolve to an IPv4 address' });
						continue;
					}
					for (const address of ipv4) {
						addresses.add(address);
					}
				} catch (error) {
					resolutionErrors.push({
						host,
						reason: (error as Error).message || 'DNS resolution failed',
					});
				}
			}

			const allowedIpv4Addresses = [...addresses].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
			return {
				...rule,
				allowedIpv4Addresses,
				resolutionErrors,
				closed: allowedIpv4Addresses.length === 0,
			};
		}),
	);
	return { rules, unusedPorts: allowlist.unusedPorts };
}

/**
 * Render the allow-list as an nftables ruleset.
 *
 * Default-deny over the whole peer range rather than per-rule accepts alone:
 * a node removed between two applications of this ruleset would otherwise
 * leave its port quietly open.
 */
export function renderNftables(allowlist: ResolvedPeerAllowlist, peerRange: { start: number; count: number }): string {
	if (
		!Number.isSafeInteger(peerRange.start) ||
		!Number.isSafeInteger(peerRange.count) ||
		peerRange.start < 1 ||
		peerRange.count < 1 ||
		peerRange.start + peerRange.count - 1 > 65_535
	) {
		throw new Error('peer port range is invalid');
	}
	const last = peerRange.start + peerRange.count - 1;
	const renderChain = (name: 'input' | 'forward'): string[] => {
		const chain = [`\tchain ${name} {`, `\t\ttype filter hook ${name} priority filter; policy accept;`, ''];
		for (const rule of allowlist.rules) {
			if (!Number.isSafeInteger(rule.peerPort) || rule.peerPort < peerRange.start || rule.peerPort > last) {
				throw new Error(`peer port is outside the managed range for node ${JSON.stringify(rule.nodeId)}`);
			}
			if (rule.allowedIpv4Addresses.some((address) => isIP(address) !== 4)) {
				throw new Error(`refusing to render a non-IPv4 peer address for node ${JSON.stringify(rule.nodeId)}`);
			}
			if (rule.closed) {
				chain.push(`\t\t# ${JSON.stringify(rule.nodeId)}: no resolved peers, port stays shut`);
				continue;
			}
			const addresses = rule.allowedIpv4Addresses.join(', ');
			chain.push(`\t\t# ${JSON.stringify(rule.nodeId)}`);
			chain.push(`\t\ttcp dport ${rule.peerPort} ip saddr { ${addresses} } accept`);
		}
		chain.push(
			'',
			'\t\t# Everything else in the peer range, including ports whose node was',
			'\t\t# removed, is refused.',
			`\t\ttcp dport ${peerRange.start}-${last} drop`,
			'\t}',
		);
		return chain;
	};

	const lines = [
		'#!/usr/sbin/nft -f',
		'# Generated by hydra-host. Peer plane only; do not hand-edit.',
		'#',
		'# Peer hosts were resolved by hydra-host. Re-apply when DNS changes.',
		'# Both hooks are required: host-network traffic traverses input, while',
		'# Docker-published bridge traffic traverses forward after DNAT.',
		'# The add + flush + declarations are one nft transaction: an update',
		'# replaces every prior accept rule without a fail-open interval.',
		'',
		'add table inet hydra_peer',
		'flush table inet hydra_peer',
		'',
		'table inet hydra_peer {',
		...renderChain('input'),
		'',
		...renderChain('forward'),
		'}',
		'',
	];

	return lines.join('\n');
}
