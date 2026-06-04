import { Network, PaymentSourceType } from '@prisma/client';
import {
	isCardanoAddressForNetwork,
	isCardanoPubKeyBaseAddressForNetwork,
	supportedPaymentSourceSchema,
	validateSupportedPaymentSourcesOrThrow,
} from './payment-source';

const PREPROD_BASE_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';
const PREPROD_SCRIPT_ADDRESS = 'addr_test1wz7j4kmg2cs7yf92uat3ed4a3u97kr7axxr4avaz0lhwdsqukgwfm';

describe('payment-source address validation', () => {
	it('keeps script addresses valid for supported payment source metadata', () => {
		expect(isCardanoAddressForNetwork(PREPROD_SCRIPT_ADDRESS, Network.Preprod)).toBe(true);
	});

	it('requires a stake credential for V2 return addresses', () => {
		expect(isCardanoPubKeyBaseAddressForNetwork(PREPROD_BASE_ADDRESS, Network.Preprod)).toBe(true);
		expect(isCardanoPubKeyBaseAddressForNetwork(PREPROD_SCRIPT_ADDRESS, Network.Preprod)).toBe(false);
	});

	it('accepts standard x402 EVM sources for V2 registry entries without requiring address duplication', () => {
		const parsed = supportedPaymentSourceSchema.parse({
			chain: 'EVM',
			network: 'eip155:84532',
			scheme: 'Exact',
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
			asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
			amount: '10000',
			decimals: 6,
			payTo: '0x1111111111111111111111111111111111111111',
		});

		expect(() =>
			validateSupportedPaymentSourcesOrThrow([parsed], Network.Preprod, PaymentSourceType.Web3CardanoV1),
		).toThrow('x402 payment sources may only be advertised by V2 registry entries.');
	});
});
