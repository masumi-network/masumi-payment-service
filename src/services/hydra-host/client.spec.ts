import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { logger } from '@masumi/payment-core/logger';
import { fetchHostCapabilities, provisionNodeOnHost } from './client';

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

describe('Hydra Host transport security', () => {
	it('does not send a bearer token to a stored remote plaintext URL', async () => {
		const fetchMock = jest.fn<() => Promise<Response>>();
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			fetchHostCapabilities('http://10.0.0.8:4000', 'admin-token', { allowInsecureHttp: false }),
		).rejects.toThrow(/explicit allowInsecureHttp/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends to HTTP only after the persisted opt-in is supplied', async () => {
		const fetchMock = jest.fn<() => Promise<Response>>().mockResolvedValue(
			new Response(
				JSON.stringify({
					hydraVersion: '0.20.0',
					network: 'Preprod',
					exchangeUrl: 'https://exchange.example.com:8444/exchange',
					nodeSlots: { used: 0, capacity: 2 },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		await expect(
			fetchHostCapabilities('http://10.0.0.8:4000', 'admin-token', { allowInsecureHttp: true }),
		).resolves.toMatchObject({
			hydraVersion: '0.20.0',
			exchangeUrl: 'https://exchange.example.com:8444/exchange',
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects an insecure public Exchange Plane URL reported by the Host', async () => {
		global.fetch = jest.fn<() => Promise<Response>>().mockResolvedValue(
			new Response(
				JSON.stringify({
					hydraVersion: '0.20.0',
					network: 'Preprod',
					exchangeUrl: 'http://exchange.example.com:8444/exchange',
					nodeSlots: { used: 0, capacity: 2 },
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			),
		) as unknown as typeof fetch;

		await expect(
			fetchHostCapabilities('https://hydra.example.com', 'admin-token', { allowInsecureHttp: false }),
		).resolves.toMatchObject({ exchangeUrl: null });
	});
});

describe('provisioning against a Host that overrides the deposit activation', () => {
	function hostResponse(depositActivationSeconds: number): Response {
		return new Response(
			JSON.stringify({
				nodeId: 'node-1',
				advertise: 'hydra1.example.com:5001',
				peerPort: 5001,
				hydraVerificationKey: 'hydra-vk',
				cardanoVerificationKey: 'cardano-vk',
				depositPeriodSeconds: 900,
				depositActivationSeconds,
			}),
			{ status: 201, headers: { 'Content-Type': 'application/json' } },
		);
	}

	// Nothing else on the wire reports this: Capabilities does not carry the
	// activation and the signed invite deliberately excludes it. If the two
	// Hosts of a head disagree, no top-up can be co-signed, and both sides still
	// render usableFrom and absorbBy normally.
	it('warns when the effective activation is not the one asked for', async () => {
		global.fetch = jest.fn<() => Promise<Response>>().mockResolvedValue(hostResponse(777)) as unknown as typeof fetch;
		const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

		await provisionNodeOnHost(
			'https://hydra.example.com',
			'admin-token',
			'idem-1',
			{ depositPeriodSeconds: 900, depositActivationSeconds: 900 },
			{ allowInsecureHttp: false },
		);

		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('overrode the deposit activation'),
			expect.objectContaining({ requested: 900, effective: 777 }),
		);
		warn.mockRestore();
	});

	it('stays quiet when the Host honoured the request', async () => {
		global.fetch = jest.fn<() => Promise<Response>>().mockResolvedValue(hostResponse(900)) as unknown as typeof fetch;
		const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

		await provisionNodeOnHost(
			'https://hydra.example.com',
			'admin-token',
			'idem-2',
			{ depositPeriodSeconds: 900, depositActivationSeconds: 900 },
			{ allowInsecureHttp: false },
		);

		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
