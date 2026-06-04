import { Network, PaymentSourceType, PricingType } from '@/generated/prisma/client';
import { buildAgentMetadata } from './service';

describe('V1 registry metadata', () => {
	it('does not advertise persisted x402 EVM rows in V1 metadata', () => {
		const smartContractAddress = 'addr_test1vpcardanoescrowaddress';

		const metadata = buildAgentMetadata(
			{
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
				metadataVersion: 2,
				SupportedPaymentSources: [
					{
						chain: 'EVM',
						network: 'eip155:84532',
						paymentSourceType: null,
						address: '0x1111111111111111111111111111111111111111',
						payTo: '0x1111111111111111111111111111111111111111',
					},
				],
			},
			{
				network: Network.Preprod,
				paymentSourceType: PaymentSourceType.Web3CardanoV1,
				smartContractAddress,
			},
		) as { supported_payment_sources?: unknown };

		expect(metadata.supported_payment_sources).toEqual([
			{
				chain: ['Cardano'],
				network: [Network.Preprod],
				paymentSourceType: [PaymentSourceType.Web3CardanoV1],
				address: [smartContractAddress],
			},
		]);
	});
});
