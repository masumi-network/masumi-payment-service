import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockHotWalletFindFirst = jest.fn() as AnyMock;
const mockTransferCreate = jest.fn() as AnyMock;
const mockTransferCount = jest.fn() as AnyMock;
const mockAddressesUtxosAll = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		hotWallet: { findFirst: mockHotWalletFindFirst },
		walletFundTransfer: { create: mockTransferCreate, count: mockTransferCount },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { ENCRYPTION_KEY: '12345678901234567890' },
	CONSTANTS: { MIN_TOPUP_LOVELACE: 5_000_000n },
	SERVICE_CONSTANTS: { RETRY: { maxRetries: 5, backoffMultiplier: 5, initialDelayMs: 500, maxDelayMs: 7500 } },
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ addressesUtxosAll: mockAddressesUtxosAll }),
}));

let postWalletConsolidateEndpointPost: typeof import('./index').postWalletConsolidateEndpointPost;

beforeAll(async () => {
	({ postWalletConsolidateEndpointPost } = await import('./index'));
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

const wallet = {
	id: 'wallet-1',
	walletAddress: 'addr_test_source',
	deletedAt: null,
	lockedAt: null,
	pendingTransactionId: null,
	PaymentSource: { network: Network.Preprod, PaymentSourceConfig: { rpcProviderApiKey: 'key' } },
};

beforeEach(() => {
	jest.clearAllMocks();
	mockFindApiKey.mockResolvedValue(adminKey);
	mockHotWalletFindFirst.mockResolvedValue(wallet);
	mockTransferCount.mockResolvedValue(0);
	mockAddressesUtxosAll.mockResolvedValue([
		{ amount: [{ unit: 'lovelace', quantity: '10000000' }] },
		{ amount: [{ unit: 'lovelace', quantity: '3000000' }] },
	]);
	mockTransferCreate.mockImplementation(async (args: any) => ({
		id: 'transfer-1',
		status: 'Pending',
		txHash: null,
		toAddress: args.data.toAddress,
		lovelaceAmount: args.data.lovelaceAmount,
		assets: Array.isArray(args.data.assets) ? args.data.assets : null,
		createdAt: new Date(),
		updatedAt: new Date(),
		lastCheckedAt: null,
		errorNote: null,
	}));
});

async function postConsolidate() {
	return testEndpoint({
		endpoint: postWalletConsolidateEndpointPost,
		requestProps: { method: 'POST', body: { walletAddress: 'addr_test_source' }, headers: { token: 'valid' } },
	});
}

describe('POST /wallet/consolidate', () => {
	it('queues a transfer back to the wallet itself', async () => {
		const { responseMock } = await postConsolidate();
		expect(responseMock.statusCode).toBe(200);
		const [args] = mockTransferCreate.mock.calls[0] as [{ data: { toAddress: string; lovelaceAmount: bigint } }];
		expect(args.data.toAddress).toBe('addr_test_source');
		expect(args.data.lovelaceAmount).toBe(11_000_000n);
	});

	// A wallet mid-transaction is about to spend part of the balance just read.
	it('refuses a wallet that is locked', async () => {
		mockHotWalletFindFirst.mockResolvedValue({ ...wallet, lockedAt: new Date() });
		const { responseMock } = await postConsolidate();
		expect(responseMock.statusCode).toBe(409);
		expect(mockTransferCreate).not.toHaveBeenCalled();
	});

	it('refuses a wallet with a pending transaction', async () => {
		mockHotWalletFindFirst.mockResolvedValue({ ...wallet, pendingTransactionId: 'tx-1' });
		const { responseMock } = await postConsolidate();
		expect(responseMock.statusCode).toBe(409);
		expect(mockTransferCreate).not.toHaveBeenCalled();
	});

	it('refuses while a fund transfer is still pending', async () => {
		mockTransferCount.mockResolvedValue(1);
		const { responseMock } = await postConsolidate();
		expect(responseMock.statusCode).toBe(409);
		expect(mockTransferCreate).not.toHaveBeenCalled();
	});

	it('refuses a wallet with nothing to merge', async () => {
		mockAddressesUtxosAll.mockResolvedValue([{ amount: [{ unit: 'lovelace', quantity: '90000000' }] }]);
		const { responseMock } = await postConsolidate();
		expect(responseMock.statusCode).toBe(400);
		expect(mockTransferCreate).not.toHaveBeenCalled();
	});
});
