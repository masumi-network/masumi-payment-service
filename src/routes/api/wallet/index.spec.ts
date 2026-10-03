import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus, HotWalletType, Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindManyWallets = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		hotWallet: {
			findMany: mockFindManyWallets,
			findFirst: jest.fn(),
			update: jest.fn(),
		},
		walletFundTransfer: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn() },
		$transaction: jest.fn(),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { ENCRYPTION_KEY: '12345678901234567890' },
	CONSTANTS: { MIN_TX_FEE_BUFFER_LOVELACE: 2000000n, MIN_TOPUP_LOVELACE: 5000000n },
	SERVICE_CONSTANTS: {
		RETRY: { maxRetries: 5, backoffMultiplier: 5, initialDelayMs: 500, maxDelayMs: 7500 },
		TRANSACTION: { timeBufferMs: 150000, blockTimeBufferMs: 60000, validitySlotBuffer: 5, resultTimeSlotBuffer: 3 },
		SMART_CONTRACT: {
			collateralAmount: '5000000',
			mintQuantity: '1',
			defaultExUnits: { mem: 7000000, steps: 3000000000 },
		},
		METADATA: { nftLabel: 721, masumiLabel: 674 },
		CARDANO: { NATIVE_TOKEN: 'lovelace' },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@masumi/payment-core/metrics', () => ({
	recordBusinessEndpointError: jest.fn(),
}));

jest.unstable_mockModule('@/utils/security/encryption', () => ({
	decrypt: jest.fn(),
	encrypt: jest.fn(),
}));

jest.unstable_mockModule('@/utils/generator/wallet-generator', () => ({
	generateOfflineWallet: jest.fn(),
}));

jest.unstable_mockModule('@/services/wallets', () => ({
	serializeLowBalanceRecord: jest.fn(),
	serializeLowBalanceSummary: () => ({ isLow: false, lowRuleCount: 0, lastCheckedAt: null }),
}));

jest.unstable_mockModule('@opentelemetry/api', () => ({
	trace: { getActiveSpan: jest.fn(() => null) },
}));

const { queryWalletListEndpointGet } = await import('./index');

const asApiKey = (flags: { canRead: boolean; canPay: boolean; canAdmin: boolean }) => ({
	id: 'api-key-1',
	canRead: flags.canRead,
	canPay: flags.canPay,
	canAdmin: flags.canAdmin,
	status: ApiKeyStatus.Active,
	token: null,
	tokenHash: null,
	tokenHashSecure: 'pbkdf2-placeholder',
	usageLimited: !flags.canAdmin,
	networkLimit: flags.canAdmin ? [Network.Preprod, Network.Mainnet] : [Network.Preprod],
	walletScopeEnabled: false,
	WalletScopes: [],
});

/** Runs the list endpoint and hands back the `where` Prisma was called with. */
const listWith = async (query: Record<string, string>, flags = { canRead: true, canPay: false, canAdmin: true }) => {
	mockFindApiKey.mockResolvedValue(asApiKey(flags));
	mockFindManyWallets.mockResolvedValue([]);

	const { responseMock } = await testEndpoint({
		endpoint: queryWalletListEndpointGet,
		requestProps: { method: 'GET', headers: { token: 'valid' }, query },
	});

	return {
		statusCode: responseMock.statusCode,
		where: mockFindManyWallets.mock.calls[mockFindManyWallets.mock.calls.length - 1]?.[0]?.where,
	};
};

describe('queryWalletListEndpointGet searchQuery', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('applies no search condition when the parameter is absent', async () => {
		const { statusCode, where } = await listWith({ take: '10' });

		expect(statusCode).toBe(200);
		expect(where.OR).toBeUndefined();
	});

	it('applies no search condition for a whitespace-only query', async () => {
		const { statusCode, where } = await listWith({ take: '10', searchQuery: '   ' });

		expect(statusCode).toBe(200);
		expect(where.OR).toBeUndefined();
	});

	it('searches the stored wallet columns before pagination', async () => {
		const { statusCode, where } = await listWith({ take: '10', searchQuery: 'Treasury' });

		expect(statusCode).toBe(200);
		// Lowercased by normalizeSearchQuery, so it agrees with the frontend mirror.
		expect(where.OR).toEqual(
			expect.arrayContaining([
				{ walletAddress: { contains: 'treasury', mode: 'insensitive' } },
				{ note: { contains: 'treasury', mode: 'insensitive' } },
			]),
		);
	});

	it('keeps the search alongside the cursor so it filters the whole table, not one page', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey({ canRead: true, canPay: false, canAdmin: true }));
		mockFindManyWallets.mockResolvedValue([]);

		await testEndpoint({
			endpoint: queryWalletListEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: { take: '5', cursorId: 'wallet-5', searchQuery: 'treasury' },
			},
		});

		const args = mockFindManyWallets.mock.calls[mockFindManyWallets.mock.calls.length - 1]?.[0];
		// Inclusive cursor (no `skip: 1`) is unchanged by the search — see
		// docs/development.md#api-pagination.
		expect(args.cursor).toEqual({ id: 'wallet-5' });
		expect(args.where.OR).toBeDefined();
	});

	it('matches LIKE metacharacters literally', async () => {
		const { where } = await listWith({ take: '10', searchQuery: '100%' });

		expect(where.OR).toContainEqual({ note: { contains: '100\\%', mode: 'insensitive' } });
	});

	it('finds a wallet by the type label the admin UI renders', async () => {
		const { where } = await listWith({ take: '10', searchQuery: 'buying' });

		expect(where.OR).toContainEqual({ type: { in: [HotWalletType.Purchasing] } });
	});

	it('rejects a query past the shared 500-character bound', async () => {
		mockFindApiKey.mockResolvedValue(asApiKey({ canRead: true, canPay: false, canAdmin: true }));

		const { responseMock } = await testEndpoint({
			endpoint: queryWalletListEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: { take: '10', searchQuery: 'a'.repeat(501) },
			},
		});

		expect(responseMock.statusCode).toBe(400);
		expect(mockFindManyWallets).not.toHaveBeenCalled();
	});

	it('does not let a read key reach Funding wallets by searching for them', async () => {
		// The search's type branch is a separate OR key, so Prisma AND-s it with
		// the read-key restriction rather than widening it. Without that, a read
		// key could enumerate the operator's treasury and then track it through
		// the read-level /balance and /utxos endpoints.
		const { statusCode, where } = await listWith(
			{ take: '10', searchQuery: 'funding' },
			{ canRead: true, canPay: false, canAdmin: false },
		);

		expect(statusCode).toBe(200);
		expect(where.type).toEqual({ in: [HotWalletType.Selling, HotWalletType.Purchasing] });
		expect(where.OR).toContainEqual({ type: { in: [HotWalletType.Funding] } });
	});

	it('keeps the wallet-scope restriction alongside the search', async () => {
		// A scoped key must not reach an out-of-scope wallet by searching for it:
		// the scope filter is its own `id` key, AND-ed with the search's OR.
		mockFindApiKey.mockResolvedValue({
			...asApiKey({ canRead: true, canPay: false, canAdmin: false }),
			walletScopeEnabled: true,
			WalletScopes: [{ hotWalletId: 'wallet-in-scope' }],
		});
		mockFindManyWallets.mockResolvedValue([]);

		await testEndpoint({
			endpoint: queryWalletListEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: { take: '10', searchQuery: 'seeding' },
			},
		});

		const where = mockFindManyWallets.mock.calls[mockFindManyWallets.mock.calls.length - 1]?.[0]?.where;
		expect(where.id).toEqual({ in: ['wallet-in-scope'] });
		expect(where.OR).toBeDefined();
	});
});
