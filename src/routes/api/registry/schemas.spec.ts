import { RegistryEntryType } from '@/generated/prisma/enums';
import { getRegistryEndpointError } from './schemas';

describe('getRegistryEndpointError', () => {
	it('treats an absent type as Standard (requires apiBaseUrl)', () => {
		expect(getRegistryEndpointError({ apiBaseUrl: 'https://a.example' })).toBeNull();
		expect(getRegistryEndpointError({})).toBe('Standard agents require apiBaseUrl');
	});

	it('requires the matching endpoint field per type', () => {
		expect(
			getRegistryEndpointError({ type: RegistryEntryType.OpenApi, openApiSpecUrl: 'https://a/oapi.json' }),
		).toBeNull();
		expect(getRegistryEndpointError({ type: RegistryEntryType.OpenApi })).toBe('OpenApi agents require openApiSpecUrl');
		expect(
			getRegistryEndpointError({ type: RegistryEntryType.X402, x402ResourcesUrl: 'https://a/x402.json' }),
		).toBeNull();
		expect(getRegistryEndpointError({ type: RegistryEntryType.X402 })).toBe('X402 agents require x402ResourcesUrl');
	});

	it('forbids an endpoint field that belongs to another type', () => {
		expect(
			getRegistryEndpointError({
				type: RegistryEntryType.OpenApi,
				openApiSpecUrl: 'https://a/oapi.json',
				apiBaseUrl: 'https://a.example',
			}),
		).toBe('apiBaseUrl is not valid for a OpenApi agent; use openApiSpecUrl');

		expect(
			getRegistryEndpointError({
				type: RegistryEntryType.Standard,
				apiBaseUrl: 'https://a.example',
				x402ResourcesUrl: 'https://a/x402.json',
			}),
		).toBe('x402ResourcesUrl is not valid for a Standard agent; use apiBaseUrl');
	});

	describe('A2A (requires both apiBaseUrl and a2aAgentCardUrl, plus non-empty a2aProtocolVersions)', () => {
		it('accepts a valid A2A request', () => {
			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.A2A,
					apiBaseUrl: 'https://a.example',
					a2aAgentCardUrl: 'https://a.example/.well-known/agent-card.json',
					a2aProtocolVersions: ['1.0'],
				}),
			).toBeNull();
		});

		it('requires apiBaseUrl', () => {
			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.A2A,
					a2aAgentCardUrl: 'https://a.example/.well-known/agent-card.json',
					a2aProtocolVersions: ['1.0'],
				}),
			).toBe('A2A agents require apiBaseUrl');
		});

		it('requires a2aAgentCardUrl', () => {
			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.A2A,
					apiBaseUrl: 'https://a.example',
					a2aProtocolVersions: ['1.0'],
				}),
			).toBe('A2A agents require a2aAgentCardUrl');
		});

		it('requires a non-empty a2aProtocolVersions', () => {
			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.A2A,
					apiBaseUrl: 'https://a.example',
					a2aAgentCardUrl: 'https://a.example/.well-known/agent-card.json',
					a2aProtocolVersions: [],
				}),
			).toBe('A2A agents require a non-empty a2aProtocolVersions');
		});

		it('forbids openApiSpecUrl/x402ResourcesUrl on an A2A request', () => {
			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.A2A,
					apiBaseUrl: 'https://a.example',
					a2aAgentCardUrl: 'https://a.example/.well-known/agent-card.json',
					a2aProtocolVersions: ['1.0'],
					openApiSpecUrl: 'https://a/oapi.json',
				}),
			).toBe('openApiSpecUrl is not valid for an A2A agent; use apiBaseUrl and a2aAgentCardUrl');

			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.A2A,
					apiBaseUrl: 'https://a.example',
					a2aAgentCardUrl: 'https://a.example/.well-known/agent-card.json',
					a2aProtocolVersions: ['1.0'],
					x402ResourcesUrl: 'https://a/x402.json',
				}),
			).toBe('x402ResourcesUrl is not valid for an A2A agent; use apiBaseUrl and a2aAgentCardUrl');
		});

		it('forbids a2aAgentCardUrl/a2aProtocolVersions on a non-A2A request', () => {
			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.Standard,
					apiBaseUrl: 'https://a.example',
					a2aAgentCardUrl: 'https://a.example/.well-known/agent-card.json',
				}),
			).toBe('a2aAgentCardUrl is not valid for a Standard agent');

			expect(
				getRegistryEndpointError({
					type: RegistryEntryType.Standard,
					apiBaseUrl: 'https://a.example',
					a2aProtocolVersions: ['1.0'],
				}),
			).toBe('a2aProtocolVersions is not valid for a Standard agent');
		});
	});
});
