import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { assertHostDestinationAllowed } from './destination';

type Answer = { address: string; family: 4 | 6 };

const answers =
	(...addresses: string[]) =>
	async (): Promise<Answer[]> =>
		addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

const neverResolved = jest.fn(async (): Promise<Answer[]> => {
	throw new Error('a literal address needs no lookup');
});

afterEach(() => {
	delete process.env.HYDRA_TRUSTED_PRIVATE_HOSTS;
});

// Registering a Host makes the service call whatever the address names, with a
// bearer token the caller chose, and show part of what comes back. That reached a
// hydra-node on loopback. An admin key is not an infrastructure operator.
describe('assertHostDestinationAllowed', () => {
	it.each([
		['loopback', 'http://127.0.0.1:8443'],
		['a private address', 'https://10.0.0.8'],
		['another private range', 'https://192.168.1.20:8443'],
		['the cloud metadata address', 'http://169.254.169.254'],
		['IPv6 loopback', 'http://[::1]:8443'],
		['localhost', 'http://localhost:8443'],
		['a subdomain of localhost', 'http://hydra.localhost'],
		['loopback written as one number', 'http://2130706433'],
		['loopback written in hex', 'http://0x7f.0.0.1'],
		['loopback as an IPv4-mapped IPv6 address', 'http://[::ffff:127.0.0.1]'],
	])('refuses %s', async (_label, url) => {
		await expect(assertHostDestinationAllowed(url, { trustedHosts: [], resolve: neverResolved })).rejects.toMatchObject(
			{
				statusCode: 400,
			},
		);
	});

	it('refuses a name that resolves to a private address', async () => {
		await expect(
			assertHostDestinationAllowed('https://hydra.example.com', { trustedHosts: [], resolve: answers('10.0.0.8') }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	// Choosing the public member of a mixed answer would leave the rest to
	// whichever the resolver hands back at connect time.
	it('refuses a name when any of its answers is private', async () => {
		await expect(
			assertHostDestinationAllowed('https://hydra.example.com', {
				trustedHosts: [],
				resolve: answers('8.8.8.8', '10.0.0.8'),
			}),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('accepts a name that resolves to public addresses', async () => {
		await expect(
			assertHostDestinationAllowed('https://hydra.example.com', {
				trustedHosts: [],
				resolve: answers('8.8.8.8', '2606:4700:4700::1111'),
			}),
		).resolves.toBeUndefined();
	});

	it('accepts a public literal address without a lookup', async () => {
		await expect(
			assertHostDestinationAllowed('https://8.8.8.8:8443', { trustedHosts: [], resolve: neverResolved }),
		).resolves.toBeUndefined();
	});

	it.each(['ENOTFOUND', 'EAI_AGAIN'])('refuses a name when DNS fails with %s', async (code) => {
		const unresolvable = async (): Promise<Answer[]> => {
			throw new Error(code);
		};

		await expect(
			assertHostDestinationAllowed('https://hydra.example.com', { trustedHosts: [], resolve: unresolvable }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	it('refuses a name when DNS returns no addresses', async () => {
		await expect(
			assertHostDestinationAllowed('https://hydra.example.com', { trustedHosts: [], resolve: answers() }),
		).rejects.toMatchObject({ statusCode: 400 });
	});

	describe('a host the operator has listed', () => {
		it.each([
			['a private literal', 'https://10.0.0.8:8443', '10.0.0.8'],
			['loopback', 'http://127.0.0.1:8443', '127.0.0.1'],
			['a name on a private network', 'https://hydra.internal', 'hydra.internal'],
			['a name typed in another case', 'https://HYDRA.Internal', 'hydra.internal'],
		])('is accepted: %s', async (_label, url, listed) => {
			await expect(
				assertHostDestinationAllowed(url, { trustedHosts: [listed], resolve: answers('10.0.0.8') }),
			).resolves.toBeUndefined();
		});

		it('does not open any other private host', async () => {
			await expect(
				assertHostDestinationAllowed('https://10.0.0.9', { trustedHosts: ['10.0.0.8'], resolve: neverResolved }),
			).rejects.toMatchObject({ statusCode: 400 });
		});

		it('is read from HYDRA_TRUSTED_PRIVATE_HOSTS', async () => {
			process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = ' 127.0.0.1 , Hydra.Internal ';

			await expect(
				assertHostDestinationAllowed('http://127.0.0.1:8443', { resolve: neverResolved }),
			).resolves.toBeUndefined();
			await expect(
				assertHostDestinationAllowed('https://hydra.internal', { resolve: answers('10.0.0.8') }),
			).resolves.toBeUndefined();
			await expect(assertHostDestinationAllowed('https://10.0.0.9', { resolve: neverResolved })).rejects.toMatchObject({
				statusCode: 400,
			});
		});

		it('normalizes trailing dots in both the URL and the operator list', async () => {
			process.env.HYDRA_TRUSTED_PRIVATE_HOSTS = 'Hydra.Internal.';
			const resolve = jest.fn<(_hostname: string) => Promise<Answer[]>>(answers('10.0.0.8'));

			await expect(assertHostDestinationAllowed('https://hydra.internal.', { resolve })).resolves.toBeUndefined();
			// Keep the root dot for DNS so resolver search domains cannot change the destination.
			expect(resolve).toHaveBeenCalledWith('hydra.internal.');
		});

		it('still refuses an unresolvable host the operator has listed', async () => {
			await expect(
				assertHostDestinationAllowed('https://hydra.internal', {
					trustedHosts: ['hydra.internal'],
					resolve: async () => {
						throw new Error('EAI_AGAIN');
					},
				}),
			).rejects.toMatchObject({ statusCode: 400 });
		});
	});

	it('names the setting that allows it, and not the address it found', async () => {
		const refusal = assertHostDestinationAllowed('https://hydra.example.com', {
			trustedHosts: [],
			resolve: answers('10.20.30.40'),
		});

		await expect(refusal).rejects.toThrow('HYDRA_TRUSTED_PRIVATE_HOSTS');
		await expect(refusal).rejects.not.toThrow('10.20.30.40');
	});
});
