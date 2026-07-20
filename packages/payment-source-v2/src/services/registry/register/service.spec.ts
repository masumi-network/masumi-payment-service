import { MeshTxBuilder } from '@meshsdk/core';
import { Network, PaymentSourceType, PricingType, X402PaymentScheme } from '@/generated/prisma/client';
import { buildAgentMetadata } from './service';

describe('V2 registry metadata', () => {
	const paymentSource = {
		network: Network.Preprod,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		smartContractAddress: 'addr_test1vpcardanoescrowaddress',
	};
	const x402Source = {
		chain: 'EVM',
		network: 'eip155:84532',
		paymentSourceType: null,
		address: '0x1111111111111111111111111111111111111111',
		scheme: X402PaymentScheme.Exact,
		pricingType: PricingType.Dynamic,
		asset: null,
		amount: null,
		decimals: null,
		payTo: '0x1111111111111111111111111111111111111111',
		resource: null,
		extra: null,
	};
	const baseRequest = {
		name: 'x402 Agent',
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
			pricingType: PricingType.Dynamic,
			FixedPricing: null,
		},
		metadataVersion: 2,
		SupportedPaymentSources: [x402Source],
	};

	it('keeps an explicit x402-only rail list authoritative', () => {
		const metadata = buildAgentMetadata(baseRequest, paymentSource) as {
			supported_payment_sources: Array<{ chain: string[] }>;
		};

		expect(metadata.supported_payment_sources).toHaveLength(1);
		expect(metadata.supported_payment_sources[0]?.chain).toEqual(['EVM']);
	});

	it('omits nullable JSON extras before Mesh converts CIP-25 metadata', () => {
		const metadata = buildAgentMetadata(baseRequest, paymentSource) as {
			supported_payment_sources: Array<{ settlement: { extra?: unknown } }>;
		};

		expect(metadata.supported_payment_sources[0]?.settlement).not.toHaveProperty('extra');
		expect(() => new MeshTxBuilder().metadataValue(721, metadata)).not.toThrow();
	});

	it('accepts the full on-chain limit without injecting another rail', () => {
		const sources = Array.from({ length: 25 }, (_value, index) => {
			const suffix = (index + 1).toString(16).padStart(40, '0');
			return {
				...x402Source,
				address: `0x${suffix}`,
				payTo: `0x${suffix}`,
			};
		});
		const metadata = buildAgentMetadata(
			{
				...baseRequest,
				SupportedPaymentSources: sources,
			},
			paymentSource,
		) as { supported_payment_sources: unknown[] };

		expect(metadata.supported_payment_sources).toHaveLength(25);
	});

	it('retains the historical Cardano fallback only for empty legacy rows', () => {
		const metadata = buildAgentMetadata(
			{
				...baseRequest,
				SupportedPaymentSources: [],
			},
			paymentSource,
		) as { supported_payment_sources: Array<{ chain: string[] }> };

		expect(metadata.supported_payment_sources).toHaveLength(1);
		expect(metadata.supported_payment_sources[0]?.chain).toEqual(['Cardano']);
	});
});
