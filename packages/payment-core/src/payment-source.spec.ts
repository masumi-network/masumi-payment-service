import { Network, PaymentSourceType, PricingType } from '@prisma/client';
import {
	getSupportedPaymentSourceCanonicalKey,
	isCardanoAddressForNetwork,
	isCardanoPubKeyAddressForNetwork,
	parseSupportedPaymentSourcesFromMetadata,
	supportedPaymentSourceSchema,
	validateSupportedPaymentSourcesOrThrow,
} from './payment-source';

const PREPROD_BASE_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
const PREPROD_ENTERPRISE_ADDRESS = 'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu';
const PREPROD_SCRIPT_ADDRESS = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7c';
const PAY_TO = '0x1111111111111111111111111111111111111111';

function fixedX402(amount = '10000') {
	return {
		chain: 'EVM' as const,
		network: 'eip155:84532',
		scheme: 'Exact' as const,
		payTo: PAY_TO,
		pricing: {
			pricingType: PricingType.Fixed,
			fixed: [{ asset: USDC, amount, decimals: 6 }],
		},
	};
}

function dynamicX402(withAsset = false) {
	return {
		chain: 'EVM' as const,
		network: 'eip155:8453',
		scheme: 'Exact' as const,
		payTo: PAY_TO,
		pricing: {
			pricingType: PricingType.Dynamic,
			...(withAsset ? { dynamic: [{ asset: USDC, decimals: 6 }] } : {}),
		},
	};
}

describe('payment-source address and pricing validation', () => {
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

	it('accepts source-local fixed x402 pricing for V2', () => {
		const parsed = supportedPaymentSourceSchema.parse(fixedX402());
		expect(() =>
			validateSupportedPaymentSourcesOrThrow([parsed], Network.Preprod, PaymentSourceType.Web3CardanoV2),
		).not.toThrow();
		expect(parsed.pricing).toMatchObject({ pricingType: PricingType.Fixed });
	});

	it('rejects the removed flat x402 pricing shape instead of silently converting it', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				chain: 'EVM',
				network: 'eip155:84532',
				scheme: 'Exact',
				pricingType: PricingType.Fixed,
				asset: USDC,
				amount: '10000',
				decimals: 6,
				payTo: PAY_TO,
			}),
		).toThrow();
	});

	it('rejects fixed amounts outside PostgreSQL BIGINT range', () => {
		expect(() => supportedPaymentSourceSchema.parse(fixedX402('9223372036854775808'))).toThrow(
			'Atomic amount must be between 1 and 9223372036854775807',
		);
		expect(() => supportedPaymentSourceSchema.parse(fixedX402('0'))).toThrow(
			'Atomic amount must be between 1 and 9223372036854775807',
		);
	});

	it('rejects EVM address aliases that differ from payTo', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				...fixedX402(),
				address: '0x2222222222222222222222222222222222222222',
			}),
		).toThrow('x402 address alias must match payTo');
	});

	it('rejects relative x402 resource URLs', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				...fixedX402(),
				resource: '/run',
			}),
		).toThrow();
	});

	it('rejects x402 sources for V1 registry entries', () => {
		const parsed = supportedPaymentSourceSchema.parse(fixedX402());
		expect(() =>
			validateSupportedPaymentSourcesOrThrow([parsed], Network.Preprod, PaymentSourceType.Web3CardanoV1),
		).toThrow('V1 registry entries must not advertise supported payment sources');
	});

	it('accepts asset-agnostic and ERC-20-allowlisted dynamic x402 pricing', () => {
		expect(supportedPaymentSourceSchema.parse(dynamicX402()).pricing).toEqual({
			pricingType: PricingType.Dynamic,
		});
		expect(supportedPaymentSourceSchema.parse(dynamicX402(true)).pricing).toEqual({
			pricingType: PricingType.Dynamic,
			dynamic: [{ asset: USDC, decimals: 6 }],
		});
	});

	it('rejects native assets and missing decimals for a dynamic x402 allowlist', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				...dynamicX402(),
				pricing: {
					pricingType: PricingType.Dynamic,
					dynamic: [{ asset: 'native', decimals: 18 }],
				},
			}),
		).toThrow('Dynamic x402 accepted asset must be an ERC-20 token contract address');
		expect(() =>
			supportedPaymentSourceSchema.parse({
				...dynamicX402(),
				pricing: {
					pricingType: PricingType.Dynamic,
					dynamic: [{ asset: USDC }],
				},
			}),
		).toThrow('Dynamic x402 accepted asset requires token decimals');
	});

	it('accepts free x402 pricing without an asset or amount', () => {
		const parsed = supportedPaymentSourceSchema.parse({
			...dynamicX402(),
			pricing: { pricingType: PricingType.Free },
		});
		expect(parsed.pricing).toEqual({ pricingType: PricingType.Free });
	});

	it('accepts independently-priced Cardano sources', () => {
		const first = supportedPaymentSourceSchema.parse({
			chain: 'Cardano',
			network: Network.Preprod,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
			address: PREPROD_SCRIPT_ADDRESS,
			pricing: {
				pricingType: PricingType.Fixed,
				fixed: [{ asset: '', amount: '500000' }],
			},
		});
		const second = supportedPaymentSourceSchema.parse({
			...first,
			pricing: { pricingType: PricingType.Dynamic },
		});
		expect(getSupportedPaymentSourceCanonicalKey(first)).not.toBe(getSupportedPaymentSourceCanonicalKey(second));
	});

	it('rejects Cardano decimals and dynamic asset allowlists that are not enforced by the rail', () => {
		expect(() =>
			supportedPaymentSourceSchema.parse({
				chain: 'Cardano',
				network: Network.Preprod,
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				address: PREPROD_SCRIPT_ADDRESS,
				pricing: {
					pricingType: PricingType.Fixed,
					fixed: [{ asset: '', amount: '500000', decimals: 6 }],
				},
			}),
		).toThrow('Cardano fixed pricing does not use decimals');
		expect(() =>
			supportedPaymentSourceSchema.parse({
				chain: 'Cardano',
				network: Network.Preprod,
				paymentSourceType: PaymentSourceType.Web3CardanoV2,
				address: PREPROD_SCRIPT_ADDRESS,
				pricing: {
					pricingType: PricingType.Dynamic,
					dynamic: [{ asset: '', decimals: 6 }],
				},
			}),
		).toThrow('Cardano dynamic pricing does not support an asset allowlist');
	});

	it('parses Cardano, dynamic x402, and free x402 pricing from metadata', () => {
		expect(
			parseSupportedPaymentSourcesFromMetadata([
				{
					chain: 'Cardano',
					network: 'Preprod',
					settlement: {
						paymentSourceType: 'Web3CardanoV2',
						address: PREPROD_SCRIPT_ADDRESS,
					},
					pricing: {
						pricingType: 'Fixed',
						fixed: [{ asset: '', amount: '500000' }],
					},
				},
				{
					chain: 'EVM',
					network: 'eip155:8453',
					settlement: { scheme: 'Exact', payTo: PAY_TO },
					pricing: {
						pricingType: 'Dynamic',
						dynamic: [{ asset: USDC, decimals: '6' }],
					},
				},
				{
					chain: 'EVM',
					network: 'eip155:8453',
					settlement: {
						scheme: 'Exact',
						payTo: '0x2222222222222222222222222222222222222222',
					},
					pricing: { pricingType: 'Free' },
				},
			]),
		).toEqual([
			expect.objectContaining({
				chain: 'Cardano',
				pricing: {
					pricingType: PricingType.Fixed,
					fixed: [{ asset: '', amount: '500000' }],
				},
			}),
			expect.objectContaining({
				pricing: {
					pricingType: PricingType.Dynamic,
					dynamic: [{ asset: USDC, decimals: 6 }],
				},
			}),
			expect.objectContaining({ pricing: { pricingType: PricingType.Free } }),
		]);
	});

	it('rejects canonical duplicates with a row-level error', () => {
		const first = supportedPaymentSourceSchema.parse(dynamicX402(true));
		const duplicate = supportedPaymentSourceSchema.parse({
			...dynamicX402(true),
			pricing: {
				pricingType: PricingType.Dynamic,
				dynamic: [{ asset: USDC.toLowerCase(), decimals: 6 }],
			},
		});
		expect(() =>
			validateSupportedPaymentSourcesOrThrow([first, duplicate], Network.Mainnet, PaymentSourceType.Web3CardanoV2),
		).toThrow('supportedPaymentSources[1] duplicates an earlier payment option');

		const fixed = supportedPaymentSourceSchema.parse(fixedX402('10000'));
		const fixedWithLeadingZero = supportedPaymentSourceSchema.parse(fixedX402('010000'));
		expect(() =>
			validateSupportedPaymentSourcesOrThrow(
				[fixed, fixedWithLeadingZero],
				Network.Preprod,
				PaymentSourceType.Web3CardanoV2,
			),
		).toThrow('supportedPaymentSources[1] duplicates an earlier payment option');
	});
});
