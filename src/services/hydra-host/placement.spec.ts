import { describe, expect, it } from '@jest/globals';
import {
	HostIncompatibleError,
	HostPlacementError,
	assertHostCompatible,
	selectPlacementHost,
	type PlaceableHost,
} from './placement';
import type { HostCapabilities } from './client';

function host(overrides: Partial<PlaceableHost> = {}): PlaceableHost {
	return { id: 'host-1', name: 'hydra1', network: 'Preprod', status: 'Active', hasAdminToken: true, ...overrides };
}

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
	return {
		hydraVersion: '2.3.0',
		scriptCatalogueHash: 'catalogue-hash',
		ledgerParamsHash: 'sha256:abc',
		network: 'preprod',
		exchangePort: 8444,
		exchangeUrl: 'https://exchange.hydra1.example.com:8444/exchange',
		nodeSlots: { used: 1, capacity: 32 },
		probeError: null,
		...overrides,
	};
}

describe('selectPlacementHost', () => {
	it('picks an active host on the requested network', () => {
		expect(selectPlacementHost([host()], 'Preprod').id).toBe('host-1');
	});

	it('ignores hosts on another network', () => {
		const hosts = [host({ id: 'main', network: 'Mainnet' }), host({ id: 'pre', network: 'Preprod' })];
		expect(selectPlacementHost(hosts, 'Preprod').id).toBe('pre');
	});

	it('reports clearly when no host is registered for the network', () => {
		expect(() => selectPlacementHost([host({ network: 'Mainnet' })], 'Preprod')).toThrow(
			/no hydra host is registered for network Preprod/,
		);
	});

	// Draining keeps serving the heads it already has — they cannot be moved —
	// while taking nothing new.
	it('refuses a draining, unreachable or disabled host, naming what it found', () => {
		const hosts = [host({ status: 'Draining' }), host({ id: 'h2', status: 'Unreachable' })];
		expect(() => selectPlacementHost(hosts, 'Preprod')).toThrow(HostPlacementError);
		expect(() => selectPlacementHost(hosts, 'Preprod')).toThrow(/Draining, Unreachable/);
	});

	// A host registered with only a user token can be operated but not
	// provisioned on, and that distinction should not look like "no host".
	it('refuses a host with no admin token, and says why', () => {
		expect(() => selectPlacementHost([host({ hasAdminToken: false })], 'Preprod')).toThrow(/without an admin token/);
	});

	it('is deterministic in caller-supplied order', () => {
		const hosts = [host({ id: 'a' }), host({ id: 'b' })];
		expect(selectPlacementHost(hosts, 'Preprod').id).toBe('a');
		expect(selectPlacementHost([...hosts].reverse(), 'Preprod').id).toBe('b');
	});
});

describe('assertHostCompatible', () => {
	const expected = {
		network: 'preprod',
		hydraVersion: '2.3.0',
		scriptCatalogueHash: 'catalogue-hash',
		ledgerParamsHash: 'sha256:abc',
	};

	it('accepts a matching host', () => {
		expect(() => assertHostCompatible(capabilities(), expected)).not.toThrow();
	});

	// The check that matters most: divergent cost models fail at commit time,
	// far from placement, with nothing pointing back at the cause.
	it('refuses a host whose ledger params differ', () => {
		expect(() => assertHostCompatible(capabilities({ ledgerParamsHash: 'sha256:other' }), expected)).toThrow(
			/PPViewHashesDontMatch/,
		);
	});

	it('refuses a different Hydra release', () => {
		expect(() => assertHostCompatible(capabilities({ hydraVersion: '2.4.0' }), expected)).toThrow(/expects 2.3.0/);
	});

	it('refuses a different script catalogue', () => {
		expect(() => assertHostCompatible(capabilities({ scriptCatalogueHash: 'other' }), expected)).toThrow(
			/script catalogue/,
		);
	});

	// A mismatch is only actionable if it reports what was seen: the fingerprint
	// cannot be derived from the hydra-node CLI, so this is the operator's only
	// route to the value they have to pin.
	it('reports the observed fingerprint on a catalogue mismatch', () => {
		expect(() => assertHostCompatible(capabilities({ scriptCatalogueHash: 'observed-value' }), expected)).toThrow(
			/observed-value/,
		);
	});

	it('reports the observed version, and that official builds carry a git sha', () => {
		expect(() => assertHostCompatible(capabilities({ hydraVersion: '2.3.0-abc123' }), expected)).toThrow(
			/2\.3\.0-abc123.*git sha/s,
		);
	});

	it('refuses a missing script catalogue', () => {
		expect(() => assertHostCompatible(capabilities({ scriptCatalogueHash: null }), expected)).toThrow(
			/reports no script catalogue/,
		);
	});

	it('refuses a Host that cannot publish a separate Exchange Plane URL', () => {
		expect(() => assertHostCompatible(capabilities({ exchangeUrl: null }), expected)).toThrow(/public exchange URL/);
	});

	it('refuses a host reporting no ledger params at all', () => {
		expect(() => assertHostCompatible(capabilities({ ledgerParamsHash: null }), expected)).toThrow(
			HostIncompatibleError,
		);
	});

	it('refuses a host on the wrong network', () => {
		expect(() => assertHostCompatible(capabilities({ network: 'mainnet' }), expected)).toThrow(
			/runs mainnet but this head is for preprod/,
		);
	});

	// A host that cannot describe itself may be running a different binary than
	// it reports, so placing a head on it is a guess.
	it('refuses a host that could not probe its own binary', () => {
		expect(() => assertHostCompatible(capabilities({ probeError: 'ENOENT' }), expected)).toThrow(
			/could not describe itself/,
		);
	});

	it('refuses a host with no free slots, showing the counts', () => {
		expect(() => assertHostCompatible(capabilities({ nodeSlots: { used: 32, capacity: 32 } }), expected)).toThrow(
			/32\/32/,
		);
	});
});
