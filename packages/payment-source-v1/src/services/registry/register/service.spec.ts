import { PricingType } from '@/generated/prisma/client';
import { buildAgentMetadata } from './service';

describe('V1 registry metadata', () => {
	const baseRequest = {
		name: 'Legacy Agent',
		description: null,
		apiBaseUrl: 'https://agent.example',
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
