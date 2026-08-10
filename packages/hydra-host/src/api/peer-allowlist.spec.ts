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
		{ address: host === 'them.example.com' ? '203.0.113.10' : '203.0.113.11', family: 4 },
	];

	it('accepts the resolved peer and drops the rest of the range', async () => {
		const ruleset = renderNftables(
			await resolvePeerAllowlist(
				buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE),
				resolveTestAddresses,
			),
			RANGE,
		);
		expect(ruleset).toContain('tcp dport 5001 ip saddr { 203.0.113.10 } accept');
		expect(ruleset).not.toContain('them.example.com } accept');
		expect(ruleset).toContain('tcp dport 5001-5004 drop');
	});

	it('filters both host-network and Docker-forwarded peer traffic', async () => {
		const ruleset = renderNftables(
			await resolvePeerAllowlist(
				buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE),
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
			await resolvePeerAllowlist(buildPeerAllowlist([node({ peers: [] })], RANGE), resolveTestAddresses),
			RANGE,
		);
		expect(ruleset.indexOf('add table inet hydra_peer')).toBeLessThan(ruleset.indexOf('flush table inet hydra_peer'));
		expect(ruleset.indexOf('flush table inet hydra_peer')).toBeLessThan(ruleset.indexOf('table inet hydra_peer {'));
	});

	// A node removed between two applications must not leave its port open.
	it('emits no accept for an unpeered node', async () => {
		const ruleset = renderNftables(
			await resolvePeerAllowlist(buildPeerAllowlist([node({ peers: [] })], RANGE), resolveTestAddresses),
			RANGE,
		);
		expect(ruleset).not.toContain('accept\n');
		expect(ruleset).toContain('no resolved peers');
	});

	it('closes a rule when DNS resolution fails', async () => {
		const allowlist = await resolvePeerAllowlist(
			buildPeerAllowlist([node({ peers: [peer('missing.example.com:5101')] })], RANGE),
			async () => {
				throw new Error('ENOTFOUND');
			},
		);
		expect(allowlist.rules[0]).toMatchObject({ closed: true, allowedIpv4Addresses: [] });
		expect(renderNftables(allowlist, RANGE)).not.toContain('missing.example.com } accept');
	});

	it('never interprets a hostname-shaped nftables interval as an address', async () => {
		const allowlist = await resolvePeerAllowlist(
			buildPeerAllowlist([node({ peers: [peer('0.0.0.0-255.255.255.255:5101')] })], RANGE),
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
				},
				RANGE,
			),
		).toThrow(/non-IPv4/);
	});
});
