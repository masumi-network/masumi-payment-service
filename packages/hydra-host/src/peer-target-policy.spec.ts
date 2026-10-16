import { describe, expect, it } from '@jest/globals';
import { createPeerTargetCheck, isPublicPeerIp, peerTargetRejection, withLookupTimeout } from './peer-target-policy.js';

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
	it('rejects loopback and metadata literals', async () => {
		for (const [advertise, address] of [
			['127.0.0.1:8443', '127.0.0.1'],
			['169.254.169.254:80', '169.254.169.254'],
			['10.0.0.5:5001', '10.0.0.5'],
		]) {
			expect(await peerTargetRejection(advertise, { allowPrivate: false, resolve: resolvesTo(address) })).toEqual({
				reason: expect.stringMatching(/non-public address/),
				transient: false,
			});
		}
	});

	it('rejects a name when any resolved address is private', async () => {
		const rejection = await peerTargetRejection('peer.example.com:5001', {
			allowPrivate: false,
			resolve: resolvesTo('203.0.114.7', '192.168.0.9'),
		});
		expect(rejection?.reason).toMatch(/192\.168\.0\.9/);
		expect(rejection?.transient).toBe(false);
	});

	it('rejects a name that does not resolve', async () => {
		const failing = async () => {
			throw new Error('ENOTFOUND');
		};
		expect(await peerTargetRejection('gone.example.com:5001', { allowPrivate: false, resolve: failing })).toEqual({
			reason: expect.stringMatching(/does not resolve/),
			transient: true,
		});
		expect(await peerTargetRejection('gone.example.com:5001', { allowPrivate: false, resolve: resolvesTo() })).toEqual({
			reason: expect.stringMatching(/does not resolve/),
			transient: true,
		});
	});

	it('accepts a name that resolves only to public addresses', async () => {
		expect(
			await peerTargetRejection('peer.example.com:5001', {
				allowPrivate: false,
				resolve: resolvesTo('203.0.114.7', '2606:4700:4700::1111'),
			}),
		).toBeNull();
	});

	it('allows private peers only when the operator opts in, without resolving', async () => {
		const resolve = async () => {
			throw new Error('must not resolve');
		};
		expect(await peerTargetRejection('10.0.0.5:5001', { allowPrivate: true, resolve })).toBeNull();
	});

	it('still rejects a malformed address when private peers are allowed', async () => {
		expect(await peerTargetRejection('10.0.0.5', { allowPrivate: true, resolve: resolvesTo('10.0.0.5') })).toEqual({
			reason: expect.stringMatching(/invalid peer advertise address/),
			transient: false,
		});
	});
});

describe('IP literals', () => {
	it('checks a canonical IP literal without a lookup', async () => {
		const resolve = async () => {
			throw new Error('must not resolve');
		};
		expect(await peerTargetRejection('127.0.0.1:8443', { allowPrivate: false, resolve })).toEqual({
			reason: expect.stringMatching(/non-public address 127\.0\.0\.1/),
			transient: false,
		});
		expect(await peerTargetRejection('8.8.8.8:5001', { allowPrivate: false, resolve })).toBeNull();
	});
});

describe('withLookupTimeout', () => {
	it('fails a lookup that does not answer in time', async () => {
		const hanging = withLookupTimeout(async () => await new Promise<never>(() => undefined), 20);
		await expect(hanging('slow.example.com')).rejects.toThrow(/timed out after 20ms/);
	});

	it('passes through a lookup that answers in time', async () => {
		const quick = withLookupTimeout(resolvesTo('203.0.114.7'), 1_000);
		expect(await quick('peer.example.com')).toEqual([{ address: '203.0.114.7', family: 4 }]);
	});
});

describe('createPeerTargetCheck', () => {
	it('refuses a private peer unless private peers are allowed', async () => {
		expect((await createPeerTargetCheck(false, resolvesTo('10.0.0.5'))('peer.example.com:5001'))?.reason).toMatch(
			/non-public address 10\.0\.0\.5/,
		);
		expect(await createPeerTargetCheck(true, resolvesTo('10.0.0.5'))('peer.example.com:5001')).toBeNull();
	});

	it('refuses a peer whose lookup fails', async () => {
		const failing = async () => {
			throw new Error('ENOTFOUND');
		};
		expect(await createPeerTargetCheck(false, failing)('gone.example.com:5001')).toEqual({
			reason: expect.stringMatching(/does not resolve: ENOTFOUND/),
			transient: true,
		});
	});
});
