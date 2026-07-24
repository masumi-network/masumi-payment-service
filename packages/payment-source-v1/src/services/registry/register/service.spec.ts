import { PricingType, RegistryEntryType } from '@/generated/prisma/client';
import { buildAgentMetadata } from './service';

describe('V1 registry metadata', () => {
	const baseRequest = {
		name: 'Legacy Agent',
		description: null,
		type: RegistryEntryType.Standard,
		apiBaseUrl: 'https://agent.example',
		openApiSpecUrl: null,
		x402ResourcesUrl: null,
		ExampleOutputs: [],
		capabilityName: null,
		capabilityVersion: null,
		authorName: null,
		authorContactEmail: null,
		authorContactOther: null,
		authorOrganization: null,
		privacyPolicy: null,
		terms: null,
		other: null,
		tags: [],
		Pricing: {
			pricingType: PricingType.Free,
			FixedPricing: null,
		},
		SupportedPaymentSources: [],
	};

	it('keeps metadata version 1 on the old schema shape', () => {
		const metadata = buildAgentMetadata({
			...baseRequest,
			metadataVersion: 1,
		}) as { supported_payment_sources?: unknown; verifications?: unknown; metadata_version?: unknown };

		expect(metadata.metadata_version).toBe('1');
		expect(metadata.supported_payment_sources).toBeUndefined();
		expect(metadata.verifications).toBeUndefined();
	});

	it('emits no type or openapi_spec_url for a Standard entry (byte-identical to pre-type mints)', () => {
		const metadata = buildAgentMetadata({
			...baseRequest,
			metadataVersion: 1,
		}) as { type?: unknown; openapi_spec_url?: unknown; api_base_url?: unknown };

		expect(metadata.type).toBeUndefined();
		expect(metadata.openapi_spec_url).toBeUndefined();
		expect(metadata.api_base_url).toBeDefined();
	});

	it('emits type "OpenAPI" and openapi_spec_url (and no api_base_url) for an OpenApi entry', () => {
		const metadata = buildAgentMetadata({
			...baseRequest,
			type: RegistryEntryType.OpenApi,
			apiBaseUrl: null,
			openApiSpecUrl: 'https://agent.example/openapi.json',
			metadataVersion: 1,
		}) as { type?: unknown; openapi_spec_url?: unknown; api_base_url?: unknown };

		expect(metadata.type).toBe('OpenAPI');
		// URL fields route through stringToMetadata (forceArray) -> chunk array,
		// same on-chain shape as api_base_url.
		expect(metadata.openapi_spec_url).toEqual(['https://agent.example/openapi.json']);
		expect(metadata.api_base_url).toBeUndefined();
	});

	it('emits type "x402V1" and x402_resources_url (and no api_base_url) for an X402 entry', () => {
		const metadata = buildAgentMetadata({
			...baseRequest,
			type: RegistryEntryType.X402,
			apiBaseUrl: null,
			x402ResourcesUrl: 'https://agent.example/x402/resources.json',
			metadataVersion: 1,
		}) as { type?: unknown; x402_resources_url?: unknown; api_base_url?: unknown };

		expect(metadata.type).toBe('x402V1');
		expect(metadata.x402_resources_url).toEqual(['https://agent.example/x402/resources.json']);
		expect(metadata.api_base_url).toBeUndefined();
	});

	it('rejects V2-only fields instead of silently removing them', () => {
		expect(() =>
			buildAgentMetadata({
				...baseRequest,
				metadataVersion: 1,
				SupportedPaymentSources: [
					{
						chain: 'EVM',
						network: 'eip155:84532',
						paymentSourceType: null,
						address: '0x1111111111111111111111111111111111111111',
						payTo: '0x1111111111111111111111111111111111111111',
					},
				],
			}),
		).toThrow('V1 registry requests must not contain supported payment sources');

		expect(() =>
			buildAgentMetadata({
				...baseRequest,
				metadataVersion: 2,
			}),
		).toThrow('V1 registry requests require metadata version 1');
	});
});
