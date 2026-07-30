import { describe, expect, it } from '@jest/globals';
import { buildPeerAllowlist, hostOfAdvertise, renderNftables } from './peer-allowlist.js';
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

	// IPv6 literals carry colons of their own; only the last one is the port.
	it('splits an IPv6 literal at the final colon', () => {
		expect(hostOfAdvertise('[2001:db8::1]:5101')).toBe('[2001:db8::1]');
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
	it('accepts the peer and drops the rest of the range', () => {
		const ruleset = renderNftables(
			buildPeerAllowlist([node({ peers: [peer('them.example.com:5101')] })], RANGE),
			RANGE,
		);
		expect(ruleset).toContain('tcp dport 5001 ip saddr { them.example.com } accept');
		expect(ruleset).toContain('tcp dport 5001-5004 drop');
	});

	// A node removed between two applications must not leave its port open.
	it('emits no accept for an unpeered node', () => {
		const ruleset = renderNftables(buildPeerAllowlist([node({ peers: [] })], RANGE), RANGE);
		expect(ruleset).not.toContain('accept\n');
		expect(ruleset).toContain('no peers yet');
	});
});
