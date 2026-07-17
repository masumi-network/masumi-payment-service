import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
	X402CounterpartyRole: {},
	X402EvmWalletType: {},
	prisma: {},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { error: jest.fn() },
}));

jest.unstable_mockModule('viem', () => ({
	defineChain: jest.fn(),
	http: jest.fn(),
}));

const { REMOTE_FACILITATOR_REQUEST_TIMEOUT_MS, RemoteHTTPFacilitatorClient } = await import('./remote-facilitator');

const paymentRequirements: PaymentRequirements = {
	scheme: 'exact',
	network: 'eip155:84532',
	asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
	amount: '10000',
	payTo: '0x1111111111111111111111111111111111111111',
	maxTimeoutSeconds: 300,
	extra: {},
};

const paymentPayload: PaymentPayload = {
	x402Version: 2,
	resource: { url: 'https://agent.example/run' },
	accepted: paymentRequirements,
	payload: { signature: '0xabc' },
};

const originalFetch = globalThis.fetch;

describe('remote HTTP facilitator', () => {
	afterEach(() => {
		globalThis.fetch = originalFetch;
		jest.useRealTimers();
	});

	it('requires HTTPS before a request can be constructed', () => {
		expect(() => new RemoteHTTPFacilitatorClient({ url: 'http://facilitator.example' })).toThrow(
			'x402 network facilitatorUrl must use https',
		);
	});

	it('sends auth and payment data without following redirects', async () => {
		const mockFetch = jest.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					isValid: true,
					payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		globalThis.fetch = mockFetch;
		const facilitator = new RemoteHTTPFacilitatorClient({
			url: 'https://facilitator.example/api/',
			getAuthorizationHeader: () => 'Bearer secret',
		});

		await expect(facilitator.verify(paymentPayload, paymentRequirements)).resolves.toMatchObject({ isValid: true });
		expect(mockFetch).toHaveBeenCalledWith(
			'https://facilitator.example/api/verify',
			expect.objectContaining({
				method: 'POST',
				redirect: 'error',
				headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it('accepts a successful settlement only for the requested network with an EVM transaction hash', async () => {
		const transaction = `0x${'a'.repeat(64)}`;
		globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					transaction,
					network: paymentRequirements.network,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		const facilitator = new RemoteHTTPFacilitatorClient({ url: 'https://facilitator.example' });

		await expect(facilitator.settle(paymentPayload, paymentRequirements)).resolves.toMatchObject({
			success: true,
			transaction,
			network: paymentRequirements.network,
		});
	});

	it('rejects a settlement response for a different network', async () => {
		globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					transaction: `0x${'a'.repeat(64)}`,
					network: 'eip155:1',
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		const facilitator = new RemoteHTTPFacilitatorClient({ url: 'https://facilitator.example' });

		await expect(facilitator.settle(paymentPayload, paymentRequirements)).rejects.toThrow(
			'Facilitator settle returned a different network',
		);
	});

	it('rejects a successful settlement without a 32-byte EVM transaction hash', async () => {
		globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					success: true,
					transaction: '0xnot-a-transaction-hash',
					network: paymentRequirements.network,
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		const facilitator = new RemoteHTTPFacilitatorClient({ url: 'https://facilitator.example' });

		await expect(facilitator.settle(paymentPayload, paymentRequirements)).rejects.toThrow(
			'Facilitator settle returned an invalid transaction hash',
		);
	});

	it('aborts a stalled facilitator request before the settlement stale window', async () => {
		jest.useFakeTimers();
		let requestSignal: AbortSignal | undefined;
		globalThis.fetch = jest.fn<typeof fetch>().mockImplementation(async (_url, init) => {
			requestSignal = init?.signal as AbortSignal;
			return new Promise<Response>((_resolve, reject) => {
				requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason));
			});
		});
		const facilitator = new RemoteHTTPFacilitatorClient({ url: 'https://facilitator.example' });
		const request = facilitator.settle(paymentPayload, paymentRequirements);
		const rejection = expect(request).rejects.toMatchObject({ status: 504 });

		await jest.advanceTimersByTimeAsync(REMOTE_FACILITATOR_REQUEST_TIMEOUT_MS);
		await rejection;
		expect(requestSignal?.aborted).toBe(true);
	});
});
