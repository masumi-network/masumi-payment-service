import { isCardanoAddress } from './cardano-address';

describe('Cardano address validation', () => {
	it.each([
		'addr1vpu5vlrf4xkxv2qpwngf6cjhtw542ayty80v8dyr49rf5eg0yu80w',
		'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu',
		'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx',
	])('accepts valid mainnet and preprod wallet addresses: %s', (address) => {
		expect(isCardanoAddress(address)).toBe(true);
	});

	it.each([`addr1${'a'.repeat(53)}`, 'addr_test1a', '', 'not-an-address'])(
		'rejects malformed addresses without throwing: %s',
		(address) => {
			expect(isCardanoAddress(address)).toBe(false);
		},
	);
});
