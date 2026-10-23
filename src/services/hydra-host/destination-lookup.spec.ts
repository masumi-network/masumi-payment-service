import { describe, expect, it, jest } from '@jest/globals';
import type { LookupFunction } from 'node:net';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { ResolvedAddress } from '@masumi/payment-core/ssrf-guard';
import { createHydraHostLookup } from './destination';

function lookup(checkedLookup: LookupFunction, options: LookupOptions = {}): Promise<string | LookupAddress[]> {
	return new Promise((resolve, reject) => {
		checkedLookup('hydra.example.com', options, (error, address) => {
			if (error) reject(error);
			else resolve(address);
		});
	});
}

describe('Hydra Host socket lookup', () => {
	it.each(['ws://127.0.0.1:4001', 'wss://[::1]:8443'])(
		'blocks %s before a literal address can bypass the lookup callback',
		(url) => {
			expect(() => createHydraHostLookup(url, { trustedHosts: [] })).toThrow('HYDRA_TRUSTED_PRIVATE_HOSTS');
		},
	);

	it('refuses a DNS change to loopback on the next socket', async () => {
		const resolve = jest
			.fn<() => Promise<ResolvedAddress[]>>()
			.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
			.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
		const checkedLookup = createHydraHostLookup('wss://hydra.example.com', { trustedHosts: [], resolve });

		await expect(lookup(checkedLookup)).resolves.toBe('8.8.8.8');
		await expect(lookup(checkedLookup)).rejects.toMatchObject({ statusCode: 400 });
	});

	it('returns only the validated address snapshot for connection fallback', async () => {
		const addresses = [
			{ address: '8.8.8.8', family: 4 as const },
			{ address: '2606:4700:4700::1111', family: 6 as const },
		];
		const checkedLookup = createHydraHostLookup('wss://hydra.example.com', {
			trustedHosts: [],
			resolve: async () => addresses,
		});

		await expect(lookup(checkedLookup, { all: true })).resolves.toEqual(addresses);
		await expect(lookup(checkedLookup, { family: 6 })).resolves.toBe(addresses[1].address);
	});
});
