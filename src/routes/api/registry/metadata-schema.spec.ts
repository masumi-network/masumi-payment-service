import {
	PaymentSourceType,
	PricingType,
	RegistryEntryType,
	X402PaymentScheme,
} from '@/generated/prisma/client';
import { buildAgentMetadata } from '../../../../packages/payment-source-v2/src/services/registry/register/service';
import {
	mapParsedRegistryMetadataToApi,
	metadataSchema,
	resolveRegistryEntryTypeApi,
	resolveRegistryInteractionUrl,
} from './metadata-schema';

describe('registry metadata schema', () => {
	const x402Source = {
		chain: 'EVM',
		network: 'eip155:84532',
		paymentSourceType: null,
		address: '0x1111111111111111111111111111111111111111',
		scheme: X402PaymentScheme.Exact,
		dynamicAsset: null,
		dynamicDecimals: null,
		fixedDecimals: 6,
		payTo: '0x1111111111111111111111111111111111111111',
		resource: 'https://api.example.com/paid',
		extra: { name: 'USD Coin', version: '2' },
		Pricing: {
			pricingType: PricingType.Fixed,
			FixedPricing: {
				Amounts: [{ unit: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: 10000n }],
			},
		},
	};

	it('parses V2 x402 on-chain metadata without api_base_url', () => {
		const raw = buildAgentMetadata({
			name: 'x402 Agent',
			description: 'Paid HTTP resource',
			type: RegistryEntryType.X402,
			apiBaseUrl: null,
			openApiSpecUrl: null,
			x402ResourcesUrl: 'https://saas.example/api/x402/manifest/agent-1',
			ExampleOutputs: [],
			capabilityName: null,
			capabilityVersion: null,
			authorName: 'Author',
			authorContactEmail: null,
			authorContactOther: null,
			authorOrganization: null,
			privacyPolicy: null,
			terms: null,
			other: null,
			tags: ['x402'],
			Pricing: null,
			metadataVersion: 2,
			SupportedPaymentSources: [x402Source],
		});

		const parsed = metadataSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;

		expect(resolveRegistryEntryTypeApi(parsed.data)).toBe('X402');
		expect(resolveRegistryInteractionUrl(parsed.data)).toBe(
			'https://saas.example/api/x402/manifest/agent-1',
		);

		const api = mapParsedRegistryMetadataToApi(parsed.data, {
			filterPaymentSourcesForNetwork: 'Preprod',
		});
		expect(api).not.toBeNull();
		expect(api?.type).toBe('X402');
		expect(api?.x402ResourcesUrl).toBe('https://saas.example/api/x402/manifest/agent-1');
		expect(api?.apiBaseUrl).toBe('https://saas.example/api/x402/manifest/agent-1');
		expect(api?.AgentPricing).toBeNull();
		expect(api?.supportedPaymentSources).toHaveLength(1);
	});

	it('still parses standard MIP metadata with api_base_url', () => {
		const raw = buildAgentMetadata({
			name: 'MIP Agent',
			description: null,
			type: RegistryEntryType.Standard,
			apiBaseUrl: 'https://agent.example/mip',
			openApiSpecUrl: null,
			x402ResourcesUrl: null,
			ExampleOutputs: [],
			capabilityName: null,
			capabilityVersion: null,
			authorName: 'Author',
			authorContactEmail: null,
			authorContactOther: null,
			authorOrganization: null,
			privacyPolicy: null,
			terms: null,
			other: null,
			tags: ['demo'],
			Pricing: null,
			metadataVersion: 2,
			SupportedPaymentSources: [
				{
					chain: 'Cardano',
					network: 'Preprod',
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
					address: 'addr_test1wzs4e6wc95hkwezlccjw9mdvq0r0rsgx6zk34avptga3ftgn37w4g',
					scheme: null,
					dynamicAsset: null,
					dynamicDecimals: null,
					fixedDecimals: null,
					payTo: null,
					resource: null,
					extra: null,
					Pricing: {
						pricingType: PricingType.Free,
						FixedPricing: null,
					},
				},
			],
		});

		const parsed = metadataSchema.safeParse(raw);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		expect(resolveRegistryEntryTypeApi(parsed.data)).toBe('Standard');
		expect(resolveRegistryInteractionUrl(parsed.data)).toBe('https://agent.example/mip');
	});
});
