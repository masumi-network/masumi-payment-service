import { describe, expect, it, jest } from '@jest/globals';
import { lookup } from 'node:dns/promises';
import { createBoundedPeerResolver } from './peer-dns.js';
import { peerTargetRejection } from './peer-target-policy.js';

describe('bounded peer resolver', () => {
	it('retains a stalled getaddrinfo job after timeout without starting another job for the same host', async () => {
		type Address = { address: string; family: number };
		let releaseFirst: ((addresses: ReadonlyArray<Address>) => void) | undefined;
		const lookupHost = jest.fn(async (hostname: string): Promise<ReadonlyArray<Address>> => {
			if (hostname.toLowerCase() === 'first.example') {
				return await new Promise((resolve) => (releaseFirst = resolve));
			}
			return [{ address: '8.8.8.8', family: 4 }];
		});
		const resolve = createBoundedPeerResolver(lookupHost, { maxPending: 1, timeoutMs: 20 });

		await expect(resolve('FIRST.example', undefined, 'nonce-first')).rejects.toThrow('peer lookup timed out');
		await expect(resolve('first.example', undefined, 'nonce-first')).rejects.toThrow('peer lookup timed out');
		expect(lookupHost).toHaveBeenCalledTimes(1);
		await expect(resolve('second.example', undefined, 'nonce-first')).rejects.toThrow('peer resolver is busy');
		await expect(resolve('second.example')).rejects.toThrow('peer resolver is busy');

		releaseFirst?.([{ address: '8.8.4.4', family: 4 }]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(await resolve('second.example', undefined, 'nonce-first')).toEqual([{ address: '8.8.8.8', family: 4 }]);
		expect(lookupHost).toHaveBeenCalledTimes(2);
	});

	it('caps pending invite owners even when they share one hostname', async () => {
		const lookupHost = jest.fn(
			async () => await new Promise<readonly { address: string; family: number }[]>(() => undefined),
		);
		const resolve = createBoundedPeerResolver(lookupHost, { maxPending: 2, maxOwners: 1, timeoutMs: 20 });
		await expect(resolve('same.example', undefined, 'nonce-one')).rejects.toThrow('peer lookup timed out');
		await expect(resolve('same.example', undefined, 'nonce-two')).rejects.toThrow('peer resolver is busy');
		expect(lookupHost).toHaveBeenCalledTimes(1);
	});

	it('removes an aborted waiter while keeping the underlying lookup capped', async () => {
		type Address = { address: string; family: number };
		let release: ((addresses: ReadonlyArray<Address>) => void) | undefined;
		const lookupHost = jest.fn(
			async (): Promise<ReadonlyArray<Address>> => await new Promise((resolve) => (release = resolve)),
		);
		const resolve = createBoundedPeerResolver(lookupHost, { maxPending: 1, timeoutMs: 20 });
		const controller = new AbortController();
		const waiting = resolve('peer.example', controller.signal);
		await new Promise<void>((resolve) => setImmediate(resolve));
		controller.abort();
		await expect(waiting).rejects.toThrow('peer lookup was aborted');
		await expect(resolve('peer.example')).rejects.toThrow('peer lookup timed out');
		expect(lookupHost).toHaveBeenCalledTimes(1);
		release?.([{ address: '8.8.8.8', family: 4 }]);
		await new Promise<void>((resolve) => setImmediate(resolve));
	});

	it('keeps temporary lookup failures distinct from invalid peer addresses', async () => {
		const resolve = createBoundedPeerResolver(async () => await new Promise(() => undefined), {
			maxPending: 1,
			timeoutMs: 20,
		});
		await expect(peerTargetRejection('first.example:5001', { allowPrivate: false, resolve })).rejects.toThrow(
			'peer lookup timed out',
		);
		await expect(peerTargetRejection('second.example:5001', { allowPrivate: false, resolve })).rejects.toThrow(
			'peer resolver is busy',
		);
	});

	it('treats temporary getaddrinfo failures as retryable, but keeps ENOTFOUND a peer rejection', async () => {
		for (const code of ['EAI_AGAIN', 'ETIMEOUT', 'ETIMEDOUT']) {
			const resolve = createBoundedPeerResolver(async () => {
				throw Object.assign(new Error('getaddrinfo failed'), { code });
			});
			await expect(peerTargetRejection('peer.example:5001', { allowPrivate: false, resolve })).rejects.toThrow(
				'peer lookup temporarily unavailable',
			);
		}
		const resolve = createBoundedPeerResolver(async () => {
			throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
		});
		expect(await peerTargetRejection('missing.example:5001', { allowPrivate: false, resolve })).toContain(
			'does not resolve',
		);
	});

	it('uses getaddrinfo results for alternate numeric forms and hosts-file names', async () => {
		const resolve = createBoundedPeerResolver();
		for (const host of ['2130706433', '0x7f.1', 'localhost', 'LOCALHOST']) {
			const expected = await lookup(host, { all: true, verbatim: true });
			expect(await resolve(host)).toEqual(expected);
			expect(await peerTargetRejection(`${host}:5001`, { allowPrivate: false, resolve })).toMatch(
				/resolves to non-public address/,
			);
		}
	});
});
