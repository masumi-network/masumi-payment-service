import { Network, PaymentSourceType, PricingType } from '@/generated/prisma/client';
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
		SupportedPaymentSources: [
			{
				chain: 'EVM',
				network: 'eip155:84532',
				paymentSourceType: null,
				address: '0x1111111111111111111111111111111111111111',
				payTo: '0x1111111111111111111111111111111111111111',
			},
		],
	};
	const paymentSource = {
		network: Network.Preprod,
		paymentSourceType: PaymentSourceType.Web3CardanoV1,
		smartContractAddress: 'addr_test1vpcardanoescrowaddress',
	};

	it('keeps metadata version 1 on the old schema shape', () => {
		const metadata = buildAgentMetadata(
			{
				...baseRequest,
				metadataVersion: 1,
			},
			paymentSource,
		) as { supported_payment_sources?: unknown; verifications?: unknown; metadata_version?: unknown };

		expect(metadata.metadata_version).toBe('1');
		expect(metadata.supported_payment_sources).toBeUndefined();
		expect(metadata.verifications).toBeUndefined();
	});

	it('does not advertise persisted x402 EVM rows in V1 metadata', () => {
		const metadata = buildAgentMetadata(
			{
				...baseRequest,
				metadataVersion: 2,
			},
			paymentSource,
		) as { supported_payment_sources?: unknown };

		expect(metadata.supported_payment_sources).toEqual([
			{
				chain: ['Cardano'],
				network: [Network.Preprod],
				settlement: {
					paymentSourceType: [PaymentSourceType.Web3CardanoV1],
					address: [paymentSource.smartContractAddress],
				},
				pricing: { pricingType: PricingType.Free },
			},
		]);
	});
});
