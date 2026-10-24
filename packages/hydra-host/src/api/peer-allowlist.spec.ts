import { describe, expect, it } from '@jest/globals';
import { buildPeerAllowlist, hostOfAdvertise, renderNftables, resolvePeerAllowlist } from './peer-allowlist.js';
import type { NodeRecord } from '../registry/types.js';

function node(overrides: Partial<NodeRecord>): NodeRecord {
	return {
		nodeId: 'n1',
		state: 'Running',
		desired: 'Running',
		network: 'preprod',
		apiPort: 4001,
		peerPort: 5001,
		monitoringPort: 6001,
		advertise: 'us.example.com:5001',
		peers: [],
		contestationPeriodSeconds: 220,
		depositPeriodSeconds: 300,
		depositActivationSeconds: 300,
		unsyncedPeriodSeconds: 1800,
		...overrides,
	} as NodeRecord;
}

function peer(advertise: string) {
	return { advertise, hydraVerificationKey: 'hvk', cardanoVerificationKey: 'cvk' };
}

const RANGE = { start: 5001, count: 4 };

describe('hostOfAdvertise', () => {
	it('drops the port', () => {
		expect(hostOfAdvertise('peer.example.com:5101')).toBe('peer.example.com');
	});

	it('keeps a bare host', () => {
		expect(hostOfAdvertise('peer.example.com')).toBe('peer.example.com');
	});

	// The launcher does not accept IPv6 advertise addresses, so the firewall
	// renderer must fail closed instead of interpreting one differently.
	it('rejects an unsupported IPv6 literal', () => {
		expect(() => hostOfAdvertise('[2001:db8::1]:5101')).toThrow(/invalid peer advertise address/);
	});

	it('rejects values that could inject nftables statements', () => {
		expect(() => hostOfAdvertise('peer.example:5001 } accept\n}\nflush ruleset\n# :5101')).toThrow(
			/invalid peer advertise address/,
		);
	});
});

describe('buildPeerAllowlist', () => {
	it('permits exactly the configured peers', () => {
		const { rules } = buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE);
		expect(rules).toEqual([{ nodeId: 'n1', peerPort: 5001, allowedHosts: ['them.example.com'], closed: false }]);
	});

	// The dangerous window: a node exists and holds a port, but nothing may
	// legitimately talk to it yet.
	it('marks an unpeered node closed', () => {
		const { rules } = buildPeerAllowlist([node({ peers: [] })], RANGE);
		expect(rules[0]).toMatchObject({ closed: true, allowedHosts: [] });
	});

	it('deduplicates peers that share a host', () => {
		const { rules } = buildPeerAllowlist(
			[node({ peers: [peer('them.example.com:5101'), peer('them.example.com:5102')] })],
			RANGE,
		);
		expect(rules[0].allowedHosts).toEqual(['them.example.com']);
	});

	it('reports ports in the range with no node on them', () => {
		const { unusedPorts } = buildPeerAllowlist([node({ peerPort: 5002 })], RANGE);
		expect(unusedPorts).toEqual([5001, 5003, 5004]);
	});

	it('orders rules by port so the output is stable', () => {
		const { rules } = buildPeerAllowlist(
			[node({ nodeId: 'b', peerPort: 5003 }), node({ nodeId: 'a', peerPort: 5001 })],
			RANGE,
		);
		expect(rules.map((rule) => rule.nodeId)).toEqual(['a', 'b']);
	});
});

describe('renderNftables', () => {
	const resolveTestAddresses = async (host: string) => [
		{ address: host === 'them.example.com' ? '8.8.8.8' : '1.1.1.1', family: 4 },
	];

	it('accepts the resolved peer and drops the rest of the range', async () => {
		const ruleset = renderNftables(
			await resolvePeerAllowlist(
				buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE),
				false,
				resolveTestAddresses,
			),
			RANGE,
		);
		expect(ruleset).toContain('tcp dport 5001 ip saddr { 8.8.8.8 } accept');
		expect(ruleset).not.toContain('them.example.com } accept');
		expect(ruleset).toContain('tcp dport 5001-5004 drop');
	});

	it('renders a one-port range as a single port, not a zero-size interval', async () => {
		const one = { start: 5001, count: 1 };
		const ruleset = renderNftables(await resolvePeerAllowlist(buildPeerAllowlist([], one), false), one);
		expect(ruleset).toContain('\t\ttcp dport 5001 drop');
		expect(ruleset).not.toContain('5001-5001');
	});

	it('filters both host-network and Docker-forwarded peer traffic', async () => {
		const ruleset = renderNftables(
			await resolvePeerAllowlist(
				buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE),
				false,
				resolveTestAddresses,
			),
			RANGE,
		);
		expect(ruleset).toContain('chain input {');
		expect(ruleset).toContain('hook input');
		expect(ruleset).toContain('chain forward {');
		expect(ruleset).toContain('hook forward');
	});

	it('replaces all rules from a previous application in one batch', async () => {
		const ruleset = renderNftables(
			await resolvePeerAllowlist(buildPeerAllowlist([node({ peers: [] })], RANGE), false, resolveTestAddresses),
			RANGE,
		);
		expect(ruleset.indexOf('add table inet hydra_peer')).toBeLessThan(ruleset.indexOf('flush table inet hydra_peer'));
		expect(ruleset.indexOf('flush table inet hydra_peer')).toBeLessThan(ruleset.indexOf('table inet hydra_peer {'));
	});

	// A node removed between two applications must not leave its port open.
	it('emits no accept for an unpeered node', async () => {
		const ruleset = renderNftables(
			await resolvePeerAllowlist(buildPeerAllowlist([node({ peers: [] })], RANGE), false, resolveTestAddresses),
			RANGE,
		);
		expect(ruleset).not.toContain('accept\n');
		expect(ruleset).toContain('no resolved peers');
	});

	it('closes a rule when DNS resolution fails', async () => {
		const allowlist = await resolvePeerAllowlist(
			buildPeerAllowlist([node({ peers: [peer('missing.example.com:5101')] })], RANGE),
			false,
			async () => {
				throw new Error('ENOTFOUND');
			},
		);
		expect(allowlist.rules[0]).toMatchObject({ closed: true, allowedIpv4Addresses: [] });
		expect(renderNftables(allowlist, RANGE)).not.toContain('missing.example.com } accept');
	});

	it('closes a peer port when a refreshed DNS answer includes a private address', async () => {
		const peerAllowlist = buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE);
		let addresses = [{ address: '8.8.8.8', family: 4 }];
		const resolveAddresses = async () => addresses;
		const initial = await resolvePeerAllowlist(peerAllowlist, false, resolveAddresses);
		expect(initial.rules[0].allowedIpv4Addresses).toEqual(['8.8.8.8']);

		addresses = [
			{ address: '8.8.8.8', family: 4 },
			{ address: '10.0.0.7', family: 4 },
		];
		const refreshed = await resolvePeerAllowlist(peerAllowlist, false, resolveAddresses);
		expect(refreshed.rules[0]).toMatchObject({ closed: true, allowedIpv4Addresses: [] });
		expect(refreshed.rules[0].resolutionErrors[0].reason).toContain('10.0.0.7');
		expect(renderNftables(refreshed, RANGE)).not.toContain('tcp dport 5001 ip saddr');
	});

	it('closes a peer port when a DNS answer includes a private IPv6 address', async () => {
		const allowlist = await resolvePeerAllowlist(
			buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE),
			false,
			async () => [
				{ address: '8.8.8.8', family: 4 },
				{ address: 'fd00::1', family: 6 },
			],
		);
		expect(allowlist.rules[0]).toMatchObject({ closed: true, allowedIpv4Addresses: [] });
		expect(allowlist.rules[0].resolutionErrors[0].reason).toContain('fd00::1');
	});

	it('applies the private-peer opt-in to DNS answers and IP literals', async () => {
		const dnsAllowlist = buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE);
		const resolved = await resolvePeerAllowlist(dnsAllowlist, true, async () => [{ address: '10.0.0.7', family: 4 }]);
		expect(resolved.rules[0]).toMatchObject({ closed: false, allowedIpv4Addresses: ['10.0.0.7'] });

		const literalAllowlist = buildPeerAllowlist([node({ peers: [peer('10.0.0.7:5101')] })], RANGE);
		const rejected = await resolvePeerAllowlist(literalAllowlist, false);
		expect(rejected.rules[0]).toMatchObject({ closed: true, allowedIpv4Addresses: [] });
		const permitted = await resolvePeerAllowlist(literalAllowlist, true);
		expect(permitted.rules[0]).toMatchObject({ closed: false, allowedIpv4Addresses: ['10.0.0.7'] });
	});

	it('never interprets a hostname-shaped nftables interval as an address', async () => {
		const allowlist = await resolvePeerAllowlist(
			buildPeerAllowlist([node({ peers: [peer('0.0.0.0-255.255.255.255:5101')] })], RANGE),
			false,
			async () => {
				throw new Error('ENOTFOUND');
			},
		);
		const ruleset = renderNftables(allowlist, RANGE);
		expect(ruleset).not.toContain('0.0.0.0-255.255.255.255');
		expect(ruleset).not.toContain('tcp dport 5001 ip saddr');
	});

	it('rejects a non-literal address even if a caller bypasses resolution', () => {
		expect(() =>
			renderNftables(
				{
					rules: [
						{
							...buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE).rules[0],
							allowedIpv4Addresses: ['0.0.0.0-255.255.255.255'],
							resolutionErrors: [],
						},
					],
					unusedPorts: [],
					outOfRange: [],
				},
				RANGE,
			),
		).toThrow(/non-IPv4/);
	});

	// index.ts lets the Host boot with such a node after an operator narrows the
	// range. A throw here failed every refresh, so the other nodes' rules went
	// stale and no refresh could ever be acknowledged.
	it('skips a node whose port lies outside the range and still renders the rest', async () => {
		const allowlist = await resolvePeerAllowlist(
			buildPeerAllowlist(
				[
					node({ nodeId: 'n1', peerPort: 5001, peers: [peer('them.example.com:5101')] }),
					node({ nodeId: 'n9', peerPort: 5009, peers: [peer('other.example.com:5101')] }),
				],
				RANGE,
			),
			false,
			resolveTestAddresses,
		);
		expect(allowlist.outOfRange).toEqual([{ nodeId: 'n9', peerPort: 5009 }]);
		const ruleset = renderNftables(allowlist, RANGE);
		expect(ruleset).toContain('tcp dport 5001 ip saddr { 8.8.8.8 } accept');
		expect(ruleset).not.toContain('5009');
	});
});
