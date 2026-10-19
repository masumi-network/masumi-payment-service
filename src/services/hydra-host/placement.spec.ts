import { describe, expect, it } from '@jest/globals';
import {
	HostIncompatibleError,
	HostPlacementError,
	assertHostCompatible,
	listHostIncompatibilities,
	selectPlacementHost,
	type PlaceableHost,
} from './placement';
import type { HostCapabilities } from './client';

function host(overrides: Partial<PlaceableHost> = {}): PlaceableHost {
	return {
		id: 'host-1',
		name: 'hydra1',
		network: 'Preprod',
		status: 'Active',
		hasAdminToken: true,
		isPaused: false,
		...overrides,
	};
}

function capabilities(overrides: Partial<HostCapabilities> = {}): HostCapabilities {
	return {
		hydraVersion: '2.4.1',
		scriptCatalogueHash: 'catalogue-hash',
		ledgerParamsHash: 'sha256:abc',
		network: 'preprod',
		exchangePort: 8444,
		exchangeUrl: 'https://exchange.hydra1.example.com:8444/exchange',
		release: { version: null, commit: null },
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

	it('skips a paused host and reports it as Paused', () => {
		const hosts = [host({ id: 'paused', isPaused: true }), host({ id: 'free' })];
		expect(selectPlacementHost(hosts, 'Preprod').id).toBe('free');
		expect(() => selectPlacementHost([host({ isPaused: true })], 'Preprod')).toThrow(/Paused/);
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
		hydraVersion: '2.4.1',
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
		expect(() => assertHostCompatible(capabilities({ hydraVersion: '2.4.0' }), expected)).toThrow(/expects 2.4.1/);
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
		expect(() => assertHostCompatible(capabilities({ hydraVersion: '2.4.1-abc123' }), expected)).toThrow(
			/2\.4\.1-abc123.*git sha/s,
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

	// A full Host is healthy and keeps serving its heads. Only a new placement
	// needs a free slot, so the probe must not mark it Unreachable for this.
	it('accepts a full host', () => {
		expect(() => assertHostCompatible(capabilities({ nodeSlots: { used: 1, capacity: 1 } }), expected)).not.toThrow();
	});

	it('names every failed check, not only the first', () => {
		expect(() =>
			assertHostCompatible(
				capabilities({ network: 'mainnet', hydraVersion: '9.9.9', ledgerParamsHash: null }),
				expected,
			),
		).toThrow(/runs mainnet[\s\S]*runs 9\.9\.9[\s\S]*no ledger protocol parameters/);
	});
});

describe('listHostIncompatibilities', () => {
	const expected = {
		network: 'preprod',
		hydraVersion: '2.4.1',
		scriptCatalogueHash: 'catalogue-hash',
		ledgerParamsHash: 'sha256:abc',
	};

	it('finds nothing on a matching host', () => {
		expect(listHostIncompatibilities(capabilities(), expected)).toEqual([]);
	});

	it('lists one problem per failed check', () => {
		const problems = listHostIncompatibilities(
			capabilities({
				exchangeUrl: null,
				network: 'mainnet',
				hydraVersion: '9.9.9',
				scriptCatalogueHash: 'other-catalogue',
				ledgerParamsHash: 'sha256:other',
			}),
			expected,
		);
		expect(problems).toHaveLength(5);
		expect(problems[0]).toMatch(/no public exchange URL/);
		expect(problems[1]).toMatch(/runs mainnet/);
		expect(problems[2]).toMatch(/runs 9\.9\.9/);
		expect(problems[3]).toMatch(/other-catalogue/);
		expect(problems[4]).toMatch(/sha256:other/);
	});

	// A failed binary probe also leaves the version empty and the catalogue
	// null. That is one cause, so it is reported once.
	it('reports a failed binary probe once, not also as a missing version and catalogue', () => {
		const problems = listHostIncompatibilities(
			capabilities({ probeError: '--version: ENOENT', hydraVersion: '', scriptCatalogueHash: null }),
			expected,
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/could not describe itself/);
	});

	it('still checks the ledger params when the binary probe failed', () => {
		const problems = listHostIncompatibilities(
			capabilities({ probeError: 'ENOENT', ledgerParamsHash: 'sha256:other' }),
			expected,
		);
		expect(problems).toHaveLength(2);
		expect(problems[1]).toMatch(/sha256:other/);
	});

	// The probe stores the problems joined by newlines, so a problem itself must
	// not contain one or the UI would split it into two. Host-supplied text can:
	// a failed command reports its stderr after a newline.
	it('keeps each problem on one line, even when the Host sends newlines', () => {
		const probed = listHostIncompatibilities(
			capabilities({ probeError: 'Command failed: hydra-node --version\nline one\nline two' }),
			expected,
		);
		expect(probed).toEqual([
			'the hydra host could not describe itself (Command failed: hydra-node --version line one line two); ' +
				'refusing to place a head on it',
		]);

		const reported = listHostIncompatibilities(
			capabilities({
				network: 'main\nnet',
				hydraVersion: '9.9\n9',
				scriptCatalogueHash: 'other\ncatalogue',
				ledgerParamsHash: 'sha256:\nother',
			}),
			expected,
		);
		expect(reported).toHaveLength(4);
		for (const problem of reported) expect(problem).not.toContain('\n');
	});

	// Flattening is for display only. A version with a stray newline is still
	// not the reviewed version.
	it('compares the raw values, not the flattened ones', () => {
		expect(listHostIncompatibilities(capabilities({ hydraVersion: '2.4.1\n' }), expected)).toHaveLength(1);
	});

	it('ignores free slots', () => {
		expect(listHostIncompatibilities(capabilities({ nodeSlots: { used: 32, capacity: 32 } }), expected)).toEqual([]);
	});
});
