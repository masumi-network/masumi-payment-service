import { postGenerateMonthlyInvoiceSchemaInput } from './schemas';

const INVALID_CHECKSUM_ADDRESS = `addr1${'a'.repeat(53)}`;
const PREPROD_BASE_ADDRESS =
	'addr_test1qq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0czhmdlpagxe5n8ppnrf6424tt8gwweumrtg2q7234x2p2qzjenfx';

describe('monthly invoice address validation', () => {
	it('rejects a malformed checksum without throwing', () => {
		const result = postGenerateMonthlyInvoiceSchemaInput.shape.walletAddress.safeParse(INVALID_CHECKSUM_ADDRESS);
		expect(result.success).toBe(false);
	});

	it('accepts a valid base address', () => {
		expect(postGenerateMonthlyInvoiceSchemaInput.shape.walletAddress.safeParse(PREPROD_BASE_ADDRESS).success).toBe(
			true,
		);
	});
});
