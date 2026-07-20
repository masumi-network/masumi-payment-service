import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockHotWalletFindFirst = jest.fn() as AnyMock;
const mockTransferCreate = jest.fn() as AnyMock;
const mockTransferFindMany = jest.fn() as AnyMock;
const mockTransferFindFirst = jest.fn() as AnyMock;

// A real preprod address (from repo fixtures). isCardanoAddressForNetwork is
// NOT mocked — the point is to exercise the real cross-network validation.
const PREPROD_ADDR =
	'addr_test1qplhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhmsuycl5a';
const POLICY_ID = 'a'.repeat(56);

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		hotWallet: { findFirst: mockHotWalletFindFirst },
		walletFundTransfer: {
			create: mockTransferCreate,
			findMany: mockTransferFindMany,
			findFirst: mockTransferFindFirst,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { ENCRYPTION_KEY: '12345678901234567890' },
	CONSTANTS: { MIN_TOPUP_LOVELACE: 5_000_000n },
	SERVICE_CONSTANTS: { RETRY: { maxRetries: 5, backoffMultiplier: 5, initialDelayMs: 500, maxDelayMs: 7500 } },
}));

let postWalletFundEndpointPost: typeof import('./index').postWalletFundEndpointPost;
let getWalletFundEndpointGet: typeof import('./index').getWalletFundEndpointGet;

beforeAll(async () => {
	({ postWalletFundEndpointPost, getWalletFundEndpointGet } = await import('./index'));
});

const adminKey = {
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
};

const preprodWallet = {
	id: 'wallet-1',
	walletAddress: 'addr_test_source',
	deletedAt: null,
	PaymentSource: { network: Network.Preprod },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockFindApiKey.mockResolvedValue(adminKey);
	mockHotWalletFindFirst.mockResolvedValue(preprodWallet);
	mockTransferCreate.mockImplementation(async (args: any) => ({
		id: 'transfer-1',
		status: 'Pending',
		txHash: null,
		toAddress: args.data.toAddress,
		lovelaceAmount: args.data.lovelaceAmount,
		// Real Prisma reads DbNull/JsonNull sentinels back as JS null and an
		// array as itself; echo that rather than the write-time sentinel.
		assets: Array.isArray(args.data.assets) ? args.data.assets : null,
		createdAt: new Date(),
		updatedAt: new Date(),
		lastCheckedAt: null,
		errorNote: null,
	}));
});

async function postFund(input: Record<string, unknown>) {
	return testEndpoint({
		endpoint: postWalletFundEndpointPost,
		requestProps: { method: 'POST', body: input, headers: { token: 'valid' } },
	});
}

describe('POST /wallet/fund — validation & authorization', () => {
	const validBody = { fromWalletAddress: 'addr_test_source', toAddress: PREPROD_ADDR, lovelaceAmount: '5000000' };

	it('accepts a valid preprod transfer and creates the row', async () => {
		const { responseMock } = await postFund(validBody);
		expect(responseMock.statusCode).toBe(200);
		expect(mockTransferCreate).toHaveBeenCalled();
	});

	it('rejects a mainnet address on a preprod wallet with 400 (cross-network)', async () => {
		// A mainnet-only address on a Preprod source. isCardanoAddressForNetwork
		// returns false → synchronous 400 instead of an async FailedViaManualReset.
		const { responseMock } = await postFund({
			...validBody,
			toAddress: 'addr1qxlhs9snd92fmr3tzw87uujvn7nqd4ss0fn8yz7mf3y2mf3a3806uqngr7hvksqvtkmetcjcluu6xeguagwyaxevdhms',
		});
		expect(responseMock.statusCode).toBe(400);
		expect(mockTransferCreate).not.toHaveBeenCalled();
	});

	it('rejects lovelaceAmount below the 2 ADA floor with 400', async () => {
		const { responseMock } = await postFund({ ...validBody, lovelaceAmount: '1000000' });
		expect(responseMock.statusCode).toBe(400);
		expect(mockTransferCreate).not.toHaveBeenCalled();
	});

	it('returns 400 (not 500) for a non-numeric lovelaceAmount', async () => {
		const { responseMock } = await postFund({ ...validBody, lovelaceAmount: 'abc' });
		expect(responseMock.statusCode).toBe(400);
	});

	it('returns 400 for scientific / decimal lovelaceAmount', async () => {
		for (const bad of ['1e9', '1.5', '-5', '0']) {
			const { responseMock } = await postFund({ ...validBody, lovelaceAmount: bad });
			expect(responseMock.statusCode).toBe(400);
		}
	});

	it('rejects assets carrying a lovelace unit (silent-drop guard)', async () => {
		const { responseMock } = await postFund({
			...validBody,
			assets: [{ unit: 'lovelace', quantity: '1000000' }],
		});
		expect(responseMock.statusCode).toBe(400);
		expect(mockTransferCreate).not.toHaveBeenCalled();
	});

	it('rejects duplicate asset units', async () => {
		const { responseMock } = await postFund({
			...validBody,
			assets: [
				{ unit: POLICY_ID + '4d59', quantity: '10' },
				{ unit: POLICY_ID + '4d59', quantity: '20' },
			],
		});
		expect(responseMock.statusCode).toBe(400);
	});

	it('rejects a non-integer asset quantity', async () => {
		const { responseMock } = await postFund({
			...validBody,
			assets: [{ unit: POLICY_ID + '4d59', quantity: 'abc' }],
		});
		expect(responseMock.statusCode).toBe(400);
	});

	it('accepts a valid native-token bundle', async () => {
		const { responseMock } = await postFund({
			...validBody,
			assets: [{ unit: POLICY_ID + '4d59', quantity: '10' }],
		});
		expect(responseMock.statusCode).toBe(200);
	});
});

describe('GET /wallet/fund — validation', () => {
	beforeEach(() => {
		mockTransferFindMany.mockResolvedValue([]);
		mockHotWalletFindFirst.mockResolvedValue({ id: 'wallet-1' });
	});

	it('returns 400 (not 500) for a non-numeric limit', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: getWalletFundEndpointGet,
			requestProps: { method: 'GET', query: { hotWalletId: 'wallet-1', limit: 'abc' }, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(400);
	});

	it('accepts a valid numeric limit', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: getWalletFundEndpointGet,
			requestProps: { method: 'GET', query: { hotWalletId: 'wallet-1', limit: '50' }, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(200);
	});

	it('requires one of id / hotWalletId / walletAddress', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: getWalletFundEndpointGet,
			requestProps: { method: 'GET', query: {}, headers: { token: 'valid' } },
		});
		expect(responseMock.statusCode).toBe(400);
	});
});
