import { Network, PaymentSourceType, PricingType } from '@prisma/client';
import {
	isCardanoAddressForNetwork,
	isCardanoPubKeyAddressForNetwork,
	parseSupportedPaymentSourcesFromMetadata,
	supportedPaymentSourceSchema,
	validateSupportedPaymentSourcesOrThrow,
} from './payment-source';

const PREPROD_BASE_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
// Same payment key hash as PREPROD_BASE_ADDRESS, no stake credential.
const PREPROD_ENTERPRISE_ADDRESS = 'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu';
const PREPROD_SCRIPT_ADDRESS = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';

describe('payment-source address validation', () => {
	it('keeps script addresses valid for supported payment source metadata', () => {
		expect(isCardanoAddressForNetwork(PREPROD_SCRIPT_ADDRESS, Network.Preprod)).toBe(true);
	});

	it('accepts base and enterprise pubkey addresses, rejects script addresses', () => {
		expect(isCardanoPubKeyAddressForNetwork(PREPROD_BASE_ADDRESS, Network.Preprod)).toBe(true);
		expect(isCardanoPubKeyAddressForNetwork(PREPROD_ENTERPRISE_ADDRESS, Network.Preprod)).toBe(true);
		expect(isCardanoPubKeyAddressForNetwork(PREPROD_SCRIPT_ADDRESS, Network.Preprod)).toBe(false);
	});

	it('rejects addresses from the wrong network', () => {
		expect(isCardanoPubKeyAddressForNetwork(PREPROD_ENTERPRISE_ADDRESS, Network.Mainnet)).toBe(false);
	});

	it('accepts standard x402 EVM sources for V2 registry entries without requiring address duplication', () => {
		const parsed = supportedPaymentSourceSchema.parse({
			chain: 'EVM',
			network: 'eip155:84532',
			scheme: 'Exact',
			pricingType: PricingType.Fixed,
			asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
			amount: '10000',
			decimals: 6,
			payTo: '0x1111111111111111111111111111111111111111',
		});

		expect(() =>
			validateSupportedPaymentSourcesOrThrow([parsed], Network.Preprod, PaymentSourceType.Web3CardanoV2),
		).not.toThrow();
	});

	it('rejects x402 EVM address aliases that differ from payTo', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				chain: 'EVM',
				network: 'eip155:84532',
				address: '0x2222222222222222222222222222222222222222',
				scheme: 'Exact',
				pricingType: PricingType.Fixed,
				asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
				amount: '10000',
				decimals: 6,
				payTo: '0x1111111111111111111111111111111111111111',
			}),
		).toThrow('x402 address alias must match payTo');
	});

	it('rejects relative x402 resource URLs', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				chain: 'EVM',
				network: 'eip155:84532',
				scheme: 'Exact',
				pricingType: PricingType.Fixed,
				asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
				amount: '10000',
				decimals: 6,
				payTo: '0x1111111111111111111111111111111111111111',
				resource: '/run',
			}),
		).toThrow();
	});

	it('rejects standard x402 EVM sources for V1 registry entries', () => {
		const parsed = supportedPaymentSourceSchema.parse({
			chain: 'EVM',
			network: 'eip155:84532',
			scheme: 'Exact',
			pricingType: PricingType.Fixed,
			asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
			amount: '10000',
			decimals: 6,
			payTo: '0x1111111111111111111111111111111111111111',
		});

		expect(() =>
			validateSupportedPaymentSourcesOrThrow([parsed], Network.Preprod, PaymentSourceType.Web3CardanoV1),
		).toThrow('x402 payment sources may only be advertised by V2 registry entries.');
	});

	it('accepts asset-agnostic and native-asset dynamic x402 pricing', () => {
		expect(
			supportedPaymentSourceSchema.parse({
				chain: 'EVM',
				network: 'eip155:8453',
				scheme: 'Exact',
				pricingType: PricingType.Dynamic,
				payTo: '0x1111111111111111111111111111111111111111',
			}),
		).toMatchObject({ pricingType: PricingType.Dynamic });

		expect(
			supportedPaymentSourceSchema.parse({
				chain: 'EVM',
				network: 'eip155:8453',
				scheme: 'Exact',
				pricingType: PricingType.Dynamic,
				asset: 'native',
				decimals: 18,
				payTo: '0x1111111111111111111111111111111111111111',
			}),
		).toMatchObject({ asset: 'native', decimals: 18 });
	});

	it('requires a dynamic asset allowlist to include its decimals', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				chain: 'EVM',
				network: 'eip155:8453',
				scheme: 'Exact',
				pricingType: PricingType.Dynamic,
				asset: 'native',
				payTo: '0x1111111111111111111111111111111111111111',
			}),
		).toThrow('Dynamic x402 asset and decimals must be provided together');
	});

	it('accepts free x402 pricing without an asset or amount', () => {
		expect(
			supportedPaymentSourceSchema.parse({
				chain: 'EVM',
				network: 'eip155:8453',
				scheme: 'Exact',
				pricingType: PricingType.Free,
				payTo: '0x1111111111111111111111111111111111111111',
			}),
		).toMatchObject({ pricingType: PricingType.Free });
	});

	it('parses dynamic and free x402 pricing from registry metadata', () => {
		expect(
			parseSupportedPaymentSourcesFromMetadata([
				{
					chain: 'EVM',
					network: 'eip155:8453',
					settlement: {
						scheme: 'Exact',
						payTo: '0x1111111111111111111111111111111111111111',
					},
					pricing: {
						pricingType: PricingType.Dynamic,
						dynamic: [{ asset: 'native', decimals: '18' }],
					},
				},
				{
					chain: 'EVM',
					network: 'eip155:8453',
					settlement: {
						scheme: 'Exact',
						payTo: '0x2222222222222222222222222222222222222222',
					},
					pricing: { pricingType: PricingType.Free },
				},
			]),
		).toEqual([
			expect.objectContaining({
				pricingType: PricingType.Dynamic,
				asset: 'native',
				decimals: 18,
			}),
			expect.objectContaining({ pricingType: PricingType.Free }),
		]);
	});
});
