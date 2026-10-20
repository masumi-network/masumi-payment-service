import { jest } from '@jest/globals';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/enums';

const PREPROD_ENTERPRISE_ADDRESS = 'addr_test1vq0e6dy7cehm9zfqurcf8mwwg9te9nszsx5gy5q4eclpd0c75xvdu';

const mockContext = {
	requestKind: 'payment' as const,
	blockchainIdentifier: 'chain-1',
	inputHash: 'input-hash',
	resultHash: 'result-hash',
	smartContractWalletId: 'wallet-1',
	sellerHotWalletId: 'wallet-1',
	network: Network.Preprod,
	adminWalletAddresses: [PREPROD_ENTERPRISE_ADDRESS],
};

const mockLoadContext = jest.fn(async () => mockContext);
const mockVerify = jest.fn(async () => true);
const mockMarkReplay = jest.fn(async () => ({ status: 'recorded' as const }));
const mockReadPlaintext = jest.fn(async () => ({
	inputData: null as string | null,
	resultData: null as string | null,
	decryptFailed: false,
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: {
			findUnique: jest.fn(async () => ({
				id: 'api-key-1',
				canRead: true,
				canPay: false,
				canAdmin: true,
				status: ApiKeyStatus.Active,
				token: null,
				tokenHash: null,
				usageLimited: false,
				networkLimit: [Network.Preprod],
				walletScopeEnabled: false,
				WalletScopes: [],
			})),
		},
	},
}));

const { revealDataSignatureInputSchema } = await import('@/utils/signature/reveal-data-signature');

jest.unstable_mockModule('@/utils/signature/reveal-data-signature', () => ({
	loadDisputedPaymentContext: mockLoadContext,
	verifyRevealDataSignature: mockVerify,
	revealDataSignatureInputSchema,
}));

jest.unstable_mockModule('@/utils/signature/reveal-data-replay-cache', () => ({
	markRevealSignatureUsed: mockMarkReplay,
}));

jest.unstable_mockModule('@/services/dispute-disclosure/storage', () => ({
	readDisputeDisclosurePlaintext: mockReadPlaintext,
}));

const { getDisputeDataEndpointPost } = await import('./index');

function endpointPayload(responseMock: { _getJSONData: () => { data?: unknown } }) {
	const json = responseMock._getJSONData();
	return (json.data ?? json) as Record<string, unknown>;
}

const baseBody = {
	signature: 'signature',
	key: 'key',
	walletAddress: PREPROD_ENTERPRISE_ADDRESS,
	validUntil: Date.now() + 60_000,
	blockchainIdentifier: 'chain-1',
	action: 'RevealData' as const,
};

describe('get-data disclosure responses', () => {
	beforeEach(() => {
		mockLoadContext.mockClear();
		mockVerify.mockClear();
		mockMarkReplay.mockClear();
		mockReadPlaintext.mockClear();
		mockLoadContext.mockResolvedValue(mockContext);
		mockVerify.mockResolvedValue(true);
		mockMarkReplay.mockResolvedValue({ status: 'recorded' });
		mockReadPlaintext.mockResolvedValue({
			inputData: null,
			resultData: null,
			decryptFailed: false,
		});
	});

	it('returns signatureValid when signature verifies but no plaintext is stored', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: getDisputeDataEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: baseBody,
			},
		});

		expect(endpointPayload(responseMock)).toMatchObject({
			isValid: true,
			signatureValid: true,
			inputData: null,
			resultData: null,
		});
		expect(mockMarkReplay).toHaveBeenCalled();
	});

	it('returns replayRejected with signatureValid when replay cache rejects', async () => {
		mockMarkReplay.mockResolvedValueOnce({ status: 'rejected' });
		const { responseMock } = await testEndpoint({
			endpoint: getDisputeDataEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: baseBody,
			},
		});

		expect(endpointPayload(responseMock)).toMatchObject({
			isValid: false,
			signatureValid: true,
			replayRejected: true,
		});
	});

	it('returns signatureValid false when the admin signature is invalid', async () => {
		mockVerify.mockResolvedValueOnce(false);
		const { responseMock } = await testEndpoint({
			endpoint: getDisputeDataEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: baseBody,
			},
		});

		expect(endpointPayload(responseMock)).toMatchObject({
			isValid: false,
			signatureValid: false,
		});
		expect(mockMarkReplay).not.toHaveBeenCalled();
	});

	it('returns decryptFailed with signatureValid when ciphertext cannot be decrypted', async () => {
		mockReadPlaintext.mockResolvedValueOnce({
			inputData: null,
			resultData: null,
			decryptFailed: true,
		});
		const { responseMock } = await testEndpoint({
			endpoint: getDisputeDataEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: baseBody,
			},
		});

		expect(endpointPayload(responseMock)).toMatchObject({
			isValid: true,
			signatureValid: true,
			decryptFailed: true,
		});
	});

	it('returns stored plaintext on idempotent replay within validUntil', async () => {
		mockMarkReplay.mockResolvedValueOnce({ status: 'idempotent' });
		mockReadPlaintext.mockResolvedValueOnce({
			inputData: 'plain-input',
			resultData: 'plain-result',
			decryptFailed: false,
		});
		const { responseMock } = await testEndpoint({
			endpoint: getDisputeDataEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: baseBody,
			},
		});

		expect(endpointPayload(responseMock)).toMatchObject({
			isValid: true,
			inputData: 'plain-input',
			resultData: 'plain-result',
		});
	});

	it('returns stored plaintext when replay is newly recorded', async () => {
		mockReadPlaintext.mockResolvedValueOnce({
			inputData: 'plain-input',
			resultData: null,
			decryptFailed: false,
		});
		const { responseMock } = await testEndpoint({
			endpoint: getDisputeDataEndpointPost,
			requestProps: {
				method: 'POST',
				headers: { token: 'valid' },
				body: baseBody,
			},
		});

		expect(endpointPayload(responseMock)).toMatchObject({
			isValid: true,
			inputData: 'plain-input',
			resultData: null,
		});
	});
});
