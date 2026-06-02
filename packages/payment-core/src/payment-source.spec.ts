import { Network } from '@prisma/client';
import { isCardanoAddressForNetwork, isCardanoPubKeyBaseAddressForNetwork } from './payment-source';

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
});
