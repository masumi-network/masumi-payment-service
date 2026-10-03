import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import type { AuthContext } from '@masumi/payment-core/auth';
import { HotWalletType, Network, PaymentSourceType } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockPaymentSourceFindFirst = jest.fn() as AnyMock;
const mockPaymentSourceFindMany = jest.fn() as AnyMock;
const mockHotWalletFindMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentSource: {
			findFirst: mockPaymentSourceFindFirst,
			findMany: mockPaymentSourceFindMany,
		},
		hotWallet: {
			findMany: mockHotWalletFindMany,
		},
	},
}));

const {
	listAccessibleReportFacets,
	MAX_REPORT_FACET_ROWS,
	resolveAccessibleReportSource,
	resolveAuthorizedManagedWalletIds,
} = await import('./access');

function authContext(overrides: Partial<AuthContext> = {}): AuthContext {
	return {
		id: 'api-key-1',
		canRead: true,
		canPay: false,
		canAdmin: false,
		networkLimit: [Network.Preprod],
		caip2NetworkLimit: ['cardano:preprod'],
		usageLimited: false,
		walletScopeIds: null,
		x402WalletScopeIds: null,
		...overrides,
	};
}

function source(deletedAt: Date | null = null) {
	return {
		id: 'source-1',
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		network: Network.Preprod,
		paymentSourceType: PaymentSourceType.Web3CardanoV1,
		smartContractAddress: 'addr_test1contract',
		feeRatePermille: 50,
		deletedAt,
	};
}

describe('resolveAccessibleReportSource', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it.each([
		['active', null],
		['archived', new Date('2026-02-01T00:00:00.000Z')],
	] as const)('returns an accessible %s source', async (_label, deletedAt) => {
		mockPaymentSourceFindFirst.mockResolvedValue(source(deletedAt));

		await expect(resolveAccessibleReportSource(authContext(), 'source-1')).resolves.toEqual(source(deletedAt));
		const query = mockPaymentSourceFindFirst.mock.calls[0][0] as { where: Record<string, unknown> };
		expect(query.where).toEqual({ id: 'source-1', network: { in: [Network.Preprod] } });
		expect(query.where).not.toHaveProperty('deletedAt');
	});

	it('uses one generic 404 for an absent or wrong-network source', async () => {
		mockPaymentSourceFindFirst.mockResolvedValue(null);

		await expect(resolveAccessibleReportSource(authContext(), 'missing-source')).rejects.toMatchObject({
			statusCode: 404,
			message: 'Not found',
		});
		await expect(
			resolveAccessibleReportSource(authContext({ networkLimit: [Network.Mainnet] }), 'source-1'),
		).rejects.toMatchObject({ statusCode: 404, message: 'Not found' });
	});
});

describe('resolveAuthorizedManagedWalletIds', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockPaymentSourceFindFirst.mockResolvedValue(source());
	});

	it('keeps an unrestricted source unrestricted when no wallet filter is requested', async () => {
		await expect(resolveAuthorizedManagedWalletIds(authContext(), 'source-1')).resolves.toBeNull();
		expect(mockHotWalletFindMany).not.toHaveBeenCalled();
	});

	it('returns scoped wallets that belong to the source, including deleted wallets', async () => {
		mockHotWalletFindMany.mockResolvedValue([{ id: 'wallet-active' }, { id: 'wallet-deleted' }]);

		await expect(
			resolveAuthorizedManagedWalletIds(
				authContext({ walletScopeIds: ['wallet-active', 'wallet-deleted', 'other-source-wallet'] }),
				'source-1',
			),
		).resolves.toEqual(['wallet-active', 'wallet-deleted']);

		const query = mockHotWalletFindMany.mock.calls[0][0] as { where: Record<string, unknown> };
		expect(query.where).toEqual({
			paymentSourceId: 'source-1',
			id: { in: ['wallet-active', 'wallet-deleted', 'other-source-wallet'] },
			type: { in: [HotWalletType.Selling, HotWalletType.Purchasing] },
		});
		expect(query.where).not.toHaveProperty('deletedAt');
	});

	it('accepts an explicitly requested deleted wallet in scope', async () => {
		mockPaymentSourceFindFirst.mockResolvedValue(source(new Date('2026-02-01T00:00:00.000Z')));
		mockHotWalletFindMany.mockResolvedValue([{ id: 'wallet-deleted' }]);

		await expect(
			resolveAuthorizedManagedWalletIds(authContext({ walletScopeIds: ['wallet-deleted'] }), 'source-1', [
				'wallet-deleted',
			]),
		).resolves.toEqual(['wallet-deleted']);
	});

	it('rejects a Funding wallet because fund transfers are outside transaction reports', async () => {
		mockHotWalletFindMany.mockResolvedValue([]);

		await expect(
			resolveAuthorizedManagedWalletIds(authContext(), 'source-1', ['funding-wallet']),
		).rejects.toMatchObject({ statusCode: 404, message: 'Not found' });
		expect(mockHotWalletFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					type: { in: [HotWalletType.Selling, HotWalletType.Purchasing] },
				}),
			}),
		);
	});

	it('uses the generic 404 when an explicit wallet is outside the key scope', async () => {
		await expect(
			resolveAuthorizedManagedWalletIds(authContext({ walletScopeIds: ['wallet-allowed'] }), 'source-1', [
				'wallet-denied',
			]),
		).rejects.toMatchObject({ statusCode: 404, message: 'Not found' });
		expect(mockHotWalletFindMany).not.toHaveBeenCalled();
	});

	it('uses the generic 404 when an explicit wallet belongs to another source', async () => {
		mockHotWalletFindMany.mockResolvedValue([]);

		await expect(
			resolveAuthorizedManagedWalletIds(authContext(), 'source-1', ['other-source-wallet']),
		).rejects.toMatchObject({ statusCode: 404, message: 'Not found' });
	});

	it('does not query wallets when the source is outside the allowed network', async () => {
		mockPaymentSourceFindFirst.mockResolvedValue(null);

		await expect(
			resolveAuthorizedManagedWalletIds(
				authContext({ networkLimit: [Network.Mainnet], walletScopeIds: ['wallet-deleted'] }),
				'source-1',
				['wallet-deleted'],
			),
		).rejects.toMatchObject({ statusCode: 404, message: 'Not found' });
		expect(mockHotWalletFindMany).not.toHaveBeenCalled();
	});
});

describe('listAccessibleReportFacets', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('lists active and archived sources plus active and deleted scoped wallets', async () => {
		const archivedSource = { ...source(new Date('2026-02-01T00:00:00.000Z')), id: 'source-archived' };
		const wallets = [
			{
				id: 'wallet-active',
				createdAt: new Date('2026-01-02T00:00:00.000Z'),
				paymentSourceId: 'source-1',
				type: HotWalletType.Selling,
				walletAddress: 'addr_test1active',
				walletVkey: 'vkey-active',
				collectionAddress: null,
				note: null,
				deletedAt: null,
			},
			{
				id: 'wallet-deleted',
				createdAt: new Date('2026-01-03T00:00:00.000Z'),
				paymentSourceId: 'source-archived',
				type: HotWalletType.Purchasing,
				walletAddress: 'addr_test1deleted',
				walletVkey: 'vkey-deleted',
				collectionAddress: null,
				note: 'old wallet',
				deletedAt: new Date('2026-02-02T00:00:00.000Z'),
			},
		];
		mockPaymentSourceFindMany.mockResolvedValue([source(), archivedSource]);
		mockHotWalletFindMany.mockResolvedValue(wallets);

		await expect(
			listAccessibleReportFacets(authContext({ walletScopeIds: ['wallet-active', 'wallet-deleted'] })),
		).resolves.toEqual({ paymentSources: [source(), archivedSource], managedWallets: wallets });

		const sourceQuery = mockPaymentSourceFindMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
			take: number;
		};
		expect(sourceQuery.where).toEqual({ network: { in: [Network.Preprod] } });
		expect(sourceQuery.take).toBe(MAX_REPORT_FACET_ROWS + 1);
		expect(sourceQuery.where).not.toHaveProperty('deletedAt');

		const walletQuery = mockHotWalletFindMany.mock.calls[0][0] as {
			where: Record<string, unknown>;
			take: number;
		};
		expect(walletQuery.where).toEqual({
			type: { in: [HotWalletType.Selling, HotWalletType.Purchasing] },
			PaymentSource: { network: { in: [Network.Preprod] } },
			id: { in: ['wallet-active', 'wallet-deleted'] },
		});
		expect(walletQuery.take).toBe(MAX_REPORT_FACET_ROWS + 1);
		expect(walletQuery.where).not.toHaveProperty('deletedAt');
	});

	it.each([
		['payment sources', mockPaymentSourceFindMany, mockHotWalletFindMany],
		['managed wallets', mockHotWalletFindMany, mockPaymentSourceFindMany],
	] as const)('rejects oversized %s facets before serialization', async (_label, oversizedQuery, otherQuery) => {
		oversizedQuery.mockResolvedValue(Array.from({ length: MAX_REPORT_FACET_ROWS + 1 }, () => source()));
		otherQuery.mockResolvedValue([]);

		await expect(listAccessibleReportFacets(authContext())).rejects.toMatchObject({
			statusCode: 413,
			message: `Report facets exceed ${MAX_REPORT_FACET_ROWS} rows`,
		});
	});
});
