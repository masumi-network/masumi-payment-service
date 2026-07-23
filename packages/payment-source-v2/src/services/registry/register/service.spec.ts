import { MeshTxBuilder } from '@meshsdk/core';
import { Network, PaymentSourceType, PricingType, RegistryEntryType, X402PaymentScheme } from '@/generated/prisma/client';
import { parseSupportedPaymentSourcesFromMetadata } from '@/types/payment-source';
import { buildAgentMetadata } from './service';

describe('V2 registry metadata', () => {
	const x402Source = {
		chain: 'EVM',
		network: 'eip155:84532',
		paymentSourceType: null,
		address: '0x1111111111111111111111111111111111111111',
		scheme: X402PaymentScheme.Exact,
		dynamicAsset: null,
		dynamicDecimals: null,
		fixedDecimals: null,
		payTo: '0x1111111111111111111111111111111111111111',
		resource: null,
		extra: null,
		Pricing: {
			pricingType: PricingType.Dynamic,
			FixedPricing: null,
		},
	};
	const baseRequest = {
		name: 'x402 Agent',
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
		Pricing: null,
		metadataVersion: 2,
		SupportedPaymentSources: [x402Source],
	};

	it('keeps an explicit x402-only rail list authoritative', () => {
		const metadata = buildAgentMetadata(baseRequest) as {
			supported_payment_sources: Array<{ chain: string[] }>;
		};

		expect(metadata.supported_payment_sources).toHaveLength(1);
		expect(metadata.supported_payment_sources[0]?.chain).toEqual(['EVM']);
	});

	it('omits nullable JSON extras before Mesh converts CIP-25 metadata', () => {
		const metadata = buildAgentMetadata(baseRequest) as {
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
		const metadata = buildAgentMetadata({
			...baseRequest,
			SupportedPaymentSources: sources,
		}) as { supported_payment_sources: unknown[] };

		expect(metadata.supported_payment_sources).toHaveLength(25);
	});

	it('rejects an empty V2 source list instead of silently injecting Cardano', () => {
		expect(() =>
			buildAgentMetadata({
				...baseRequest,
				SupportedPaymentSources: [],
			}),
		).toThrow('V2 requires at least one supported payment source');
	});

	it('rejects a V2 row carrying a V1 metadata version instead of minting without pricing', () => {
		expect(() =>
			buildAgentMetadata({
				...baseRequest,
				metadataVersion: 1,
			}),
		).toThrow('V2 requires metadataVersion >= 2');
	});

	const cardanoFixedSource = {
		chain: 'Cardano',
		network: Network.Preprod,
		paymentSourceType: PaymentSourceType.Web3CardanoV2,
		address: 'addr_test1qqfixture000000000000000000000000000000000000000000',
		scheme: null,
		dynamicAsset: null,
		dynamicDecimals: null,
		fixedDecimals: null,
		payTo: null,
		resource: null,
		extra: null,
		Pricing: {
			pricingType: PricingType.Fixed,
			FixedPricing: { Amounts: [{ unit: '', amount: 1000000n }] },
		},
	};

	it('emits Cardano fixed pricing with lovelace as an empty-string asset and chunks long units', () => {
		const longUnit = 'a'.repeat(56) + '74657374746f6b656e';
		const metadata = buildAgentMetadata({
			...baseRequest,
			SupportedPaymentSources: [
				cardanoFixedSource,
				{
					...cardanoFixedSource,
					Pricing: {
						pricingType: PricingType.Fixed,
						FixedPricing: { Amounts: [{ unit: longUnit, amount: 5n }] },
					},
				},
			],
		}) as {
			supported_payment_sources: Array<{
				pricing: { fixed: Array<{ asset: string | string[]; amount: string; decimals?: string }> };
			}>;
		};

		const [lovelacePriced, longUnitPriced] = metadata.supported_payment_sources;
		expect(lovelacePriced.pricing.fixed[0].asset).toBe('');
		expect(lovelacePriced.pricing.fixed[0].amount).toBe('1000000');
		expect(lovelacePriced.pricing.fixed[0].decimals).toBeUndefined();
		// Long units must chunk into <=60-byte metadata strings that join back
		// to the full policyId+assetName hex.
		const chunkedAsset = longUnitPriced.pricing.fixed[0].asset;
		expect(Array.isArray(chunkedAsset)).toBe(true);
		expect((chunkedAsset as string[]).every((chunk) => chunk.length <= 60)).toBe(true);
		expect((chunkedAsset as string[]).join('')).toBe(longUnit);
	});

	it('emits EVM fixed decimals as a string and round-trips through the metadata parser', () => {
		const evmFixedSource = {
			...x402Source,
			fixedDecimals: 6,
			Pricing: {
				pricingType: PricingType.Fixed,
				FixedPricing: {
					Amounts: [{ unit: '0x2222222222222222222222222222222222222222', amount: 250000n }],
				},
			},
		};
		const metadata = buildAgentMetadata({
			...baseRequest,
			SupportedPaymentSources: [evmFixedSource, cardanoFixedSource],
		}) as {
			supported_payment_sources: Array<{ pricing: { fixed: Array<{ decimals?: string }> } }>;
		};

		expect(metadata.supported_payment_sources[0].pricing.fixed[0].decimals).toBe('6');

		const parsed = parseSupportedPaymentSourcesFromMetadata(metadata.supported_payment_sources);
		expect(parsed).not.toBeNull();
		expect(parsed).toHaveLength(2);
		expect(parsed?.[0]).toMatchObject({
			chain: 'EVM',
			payTo: evmFixedSource.payTo,
			pricing: {
				pricingType: PricingType.Fixed,
				fixed: [{ asset: '0x2222222222222222222222222222222222222222', amount: '250000', decimals: 6 }],
			},
		});
		expect(parsed?.[1]).toMatchObject({
			chain: 'Cardano',
			address: cardanoFixedSource.address,
			pricing: { pricingType: PricingType.Fixed, fixed: [{ asset: '', amount: '1000000' }] },
		});
	});

	it('rejects incomplete fixed, incomplete dynamic, and asset-carrying free x402 pricing', () => {
		expect(() =>
			buildAgentMetadata({
				...baseRequest,
				SupportedPaymentSources: [
					{
						...x402Source,
						// Fixed without decimals
						Pricing: {
							pricingType: PricingType.Fixed,
							FixedPricing: {
								Amounts: [{ unit: '0x2222222222222222222222222222222222222222', amount: 1n }],
							},
						},
					},
				],
			}),
		).toThrow('fixed x402 pricing is incomplete');

		expect(() =>
			buildAgentMetadata({
				...baseRequest,
				SupportedPaymentSources: [
					{
						...x402Source,
						dynamicAsset: '0x2222222222222222222222222222222222222222',
						dynamicDecimals: null,
					},
				],
			}),
		).toThrow('dynamic x402 pricing is incomplete');

		expect(() =>
			buildAgentMetadata({
				...baseRequest,
				SupportedPaymentSources: [
					{
						...x402Source,
						fixedDecimals: 6,
						Pricing: { pricingType: PricingType.Free, FixedPricing: null },
					},
				],
			}),
		).toThrow('free x402 pricing must not include an asset or amount');
	});
});
