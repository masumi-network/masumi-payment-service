import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, HotWalletType } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockHotWalletFindMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		hotWallet: { findMany: mockHotWalletFindMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { ENCRYPTION_KEY: '12345678901234567890' },
	CONSTANTS: { MIN_TOPUP_LOVELACE: 5_000_000n },
	SERVICE_CONSTANTS: { RETRY: { maxRetries: 5, backoffMultiplier: 5, initialDelayMs: 500, maxDelayMs: 7500 } },
}));

let queryWalletListEndpointGet: typeof import('./index').queryWalletListEndpointGet;

beforeAll(async () => {
	({ queryWalletListEndpointGet } = await import('./index'));
});

function apiKey(canAdmin: boolean) {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: canAdmin,
		canAdmin,
		status: ApiKeyStatus.Active,
		token: null,
		tokenHash: null,
		usageLimited: false,
		networkLimit: [],
		walletScopeEnabled: false,
		WalletScopes: [],
	};
}

beforeEach(() => {
	jest.clearAllMocks();
	mockFindApiKey.mockResolvedValue(apiKey(true));
	mockHotWalletFindMany.mockResolvedValue([]);
});

async function listWallets(query: Record<string, string>) {
	const { responseMock } = await testEndpoint({
		endpoint: queryWalletListEndpointGet,
		requestProps: { method: 'GET', query, headers: { token: 'valid' } },
	});
	expect(responseMock.statusCode).toBe(200);
	return mockHotWalletFindMany.mock.calls[mockHotWalletFindMany.mock.calls.length - 1]?.[0];
}

describe('GET /wallet/list searchQuery', () => {
	it('omits the search OR when no query is given', async () => {
		const args = await listWallets({});
		expect(args.where.OR).toBeUndefined();
	});

	it('matches text columns case-insensitively and wallet types by substring', async () => {
		const args = await listWallets({ searchQuery: '  SELL  ' });
		expect(args.where.OR).toEqual([
			{ walletAddress: { contains: 'sell', mode: 'insensitive' } },
			{ collectionAddress: { contains: 'sell', mode: 'insensitive' } },
			{ note: { contains: 'sell', mode: 'insensitive' } },
			{ walletVkey: { contains: 'sell', mode: 'insensitive' } },
			{ id: { contains: 'sell', mode: 'insensitive' } },
			{ type: { in: [HotWalletType.Selling] } },
		]);
	});

	it('matches LIKE wildcards literally and skips the type branch when no type matches', async () => {
		const args = await listWallets({ searchQuery: '50%_x' });
		expect(args.where.OR).toEqual([
			{ walletAddress: { contains: '50\\%\\_x', mode: 'insensitive' } },
			{ collectionAddress: { contains: '50\\%\\_x', mode: 'insensitive' } },
			{ note: { contains: '50\\%\\_x', mode: 'insensitive' } },
			{ walletVkey: { contains: '50\\%\\_x', mode: 'insensitive' } },
			{ id: { contains: '50\\%\\_x', mode: 'insensitive' } },
		]);
	});

	it('keeps Funding wallets out of a read key search for "fund"', async () => {
		mockFindApiKey.mockResolvedValue(apiKey(false));
		const args = await listWallets({ searchQuery: 'fund' });
		// The type filter and the search OR are sibling keys, so Prisma ANDs them.
		expect(args.where.type).toEqual({ in: [HotWalletType.Selling, HotWalletType.Purchasing] });
		expect(args.where.OR).toContainEqual({ type: { in: [HotWalletType.Funding] } });
	});
});
