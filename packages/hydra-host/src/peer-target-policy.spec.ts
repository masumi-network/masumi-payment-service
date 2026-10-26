import { describe, expect, it } from '@jest/globals';
import {
	assertStoredPeerEgressCompatibility,
	isPublicPeerIp,
	peerEgressPortRejection,
	peerTargetRejection,
} from './peer-target-policy.js';

const PORTS = { peerStart: 5100, apiStart: 4100, monitoringStart: 6100, capacity: 4 };

const resolvesTo =
	(...addresses: string[]) =>
	async () =>
		addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('isPublicPeerIp', () => {
	it.each([
		'127.0.0.1',
		'10.1.2.3',
		'172.16.0.1',
		'192.168.1.1',
		'169.254.169.254',
		'100.64.0.1',
		'0.0.0.0',
		'224.0.0.1',
		'255.255.255.255',
		'::1',
		'::',
		'::ffff:127.0.0.1',
		'fd00::1',
		'fe80::1',
		'64:ff9b::a9fe:a9fe',
		'2002:7f00:1::1',
		'not-an-ip',
	])('rejects %s', (address) => {
		expect(isPublicPeerIp(address)).toBe(false);
	});

	it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('accepts %s', (address) => {
		expect(isPublicPeerIp(address)).toBe(true);
	});
});

describe('peerTargetRejection', () => {
	it('rejects local outbound exceptions before DNS, including a private-peer opt-in', async () => {
		const resolve = async () => {
			throw new Error('DNS must not run');
		};
		for (const port of [53, 4100, 4103, 2478, 2481]) {
			expect(peerEgressPortRejection(`peer.example.com:${port}`, PORTS)).toMatch(/local outbound firewall exception/);
			expect(
				await peerTargetRejection(`peer.example.com:${port}`, {
					allowPrivate: true,
					resolve,
					egressPortLayout: PORTS,
				}),
			).toMatch(/local outbound firewall exception/);
		}
		expect(peerEgressPortRejection('peer.example.com:5001', PORTS)).toBeNull();
	});

	it('refuses stored heads using a local exception before the supervisor boots', () => {
		const records = [
			{ nodeId: 'old-head', apiPort: 4100, peerPort: 5100, peers: [{ advertise: 'peer.example.com:4101' }] },
		];
		expect(() => assertStoredPeerEgressCompatibility(records, PORTS)).toThrow(/stored node old-head.*4101/);
		expect(() =>
			assertStoredPeerEgressCompatibility(
				[{ nodeId: 'safe-head', apiPort: 4100, peerPort: 5100, peers: [{ advertise: 'peer.example.com:5001' }] }],
				PORTS,
			),
		).not.toThrow();
	});

	it('refuses a stored node whose original local ports are outside the egress exceptions', () => {
		const record = { nodeId: 'old-layout', apiPort: 4100, peerPort: 5100, peers: [] };
		expect(() => assertStoredPeerEgressCompatibility([{ ...record, apiPort: 4001 }], PORTS)).toThrow(
			/stored node old-layout uses API port 4001 outside outbound exception/,
		);
		expect(() => assertStoredPeerEgressCompatibility([{ ...record, peerPort: 5001 }], PORTS)).toThrow(
			/stored node old-layout uses etcd client port 2379 outside outbound exception/,
		);
	});
	it('rejects loopback and metadata literals', async () => {
		for (const [advertise, address] of [
			['127.0.0.1:8443', '127.0.0.1'],
			['169.254.169.254:80', '169.254.169.254'],
			['10.0.0.5:5001', '10.0.0.5'],
		]) {
			expect(await peerTargetRejection(advertise, { allowPrivate: false, resolve: resolvesTo(address) })).toMatch(
				/non-public address/,
			);
		}
	});

	it.each([
		['203.0.114.7', '192.168.0.9'],
		['203.0.114.7', 'fd00::1'],
		['192.168.0.9', '2606:4700:4700::1111'],
	])('rejects mixed public and private records: %s, %s', async (first, second) => {
		const rejection = await peerTargetRejection('peer.example.com:5001', {
			allowPrivate: false,
			resolve: resolvesTo(first, second),
		});
		expect(rejection).toMatch(/non-public address/);
	});

	it('rejects an AAAA-only public name that the IPv4 peer firewall cannot open', async () => {
		expect(
			await peerTargetRejection('ipv6-only.example.com:5001', {
				allowPrivate: false,
				resolve: resolvesTo('2606:4700:4700::1111', '2001:4860:4860::8888'),
			}),
		).toMatch(/does not resolve to an IPv4 address/);
	});

	it('rejects a name that does not resolve', async () => {
		const failing = async () => {
			throw new Error('ENOTFOUND');
		};
		expect(await peerTargetRejection('gone.example.com:5001', { allowPrivate: false, resolve: failing })).toMatch(
			/does not resolve/,
		);
		expect(await peerTargetRejection('gone.example.com:5001', { allowPrivate: false, resolve: resolvesTo() })).toMatch(
			/does not resolve/,
		);
	});

	it.each([['203.0.114.7'], ['203.0.114.7', '2606:4700:4700::1111'], ['2606:4700:4700::1111', '203.0.114.7']])(
		'accepts public records with an IPv4 address: %j',
		async (...addresses) => {
			expect(
				await peerTargetRejection('peer.example.com:5001', {
					allowPrivate: false,
					resolve: resolvesTo(...addresses),
				}),
			).toBeNull();
		},
	);

	it.each(['10.0.0.5:5001', 'private-peer.example.com:5001'])(
		'preserves the private-peer opt-in DNS bypass for %s',
		async (advertise) => {
			const resolve = async () => {
				throw new Error('must not resolve');
			};
			expect(await peerTargetRejection(advertise, { allowPrivate: true, resolve })).toBeNull();
		},
	);

	it('still rejects a malformed address when private peers are allowed', async () => {
		expect(await peerTargetRejection('10.0.0.5', { allowPrivate: true, resolve: resolvesTo('10.0.0.5') })).toMatch(
			/invalid peer advertise address/,
		);
	});
});
