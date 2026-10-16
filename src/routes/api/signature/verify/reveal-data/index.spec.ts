import { jest } from '@jest/globals';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/enums';

const INVALID_CHECKSUM_ADDRESS = `addr1${'a'.repeat(53)}`;
const PREPROD_ENTERPRISE_ADDRESS = 'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu';

const mockFindPayment = jest.fn(async () => ({
	onChainState: 'Disputed',
	smartContractWalletId: 'wallet-1',
	PaymentSource: {
		network: Network.Preprod,
		AdminWallets: [{ walletAddress: PREPROD_ENTERPRISE_ADDRESS }],
	},
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: jest.fn(async () => ({
				id: 'api-key-1',
				canRead: true,
				canPay: true,
				canAdmin: true,
				status: ApiKeyStatus.Active,
				token: null,
				tokenHash: null,
				usageLimited: false,
				networkLimit: [],
				walletScopeEnabled: false,
				WalletScopes: [],
			})),
		},
		paymentRequest: { findFirst: mockFindPayment },
	},
}));

const { postVerifyDataRevealSchemaInput, revealDataEndpointPost } = await import('./index');

describe('reveal-data address validation', () => {
	it('rejects a malformed checksum before the handler runs', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: revealDataEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: {
					signature: 'signature',
					key: 'key',
					walletAddress: INVALID_CHECKSUM_ADDRESS,
					validUntil: Date.now() + 60_000,
					blockchainIdentifier: 'payment-1',
					action: 'RevealData',
				},
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockFindPayment).not.toHaveBeenCalled();
	});

	it('accepts a valid enterprise address', () => {
		expect(postVerifyDataRevealSchemaInput.shape.walletAddress.safeParse(PREPROD_ENTERPRISE_ADDRESS).success).toBe(
			true,
		);
	});
});
