import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { testEndpoint } from 'express-zod-api';
import { ApiKeyStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindApiKey = jest.fn() as AnyMock;
const mockFindDistributions = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		apiKey: { findUnique: mockFindApiKey },
		fundDistributionRequest: { findMany: mockFindDistributions },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/wallets', () => ({
	fundDistributionService: {
		isRunning: jest.fn(() => false),
		processDistributionCycle: jest.fn(async () => undefined),
	},
}));

const { getFundDistributionEndpointGet } = await import('./index');

const asApiKey = () => ({
	id: 'api-key-1',
	canRead: true,
	canPay: true,
	canAdmin: true,
	status: ApiKeyStatus.Active,
	token: null,
	tokenHash: null,
	tokenHashSecure: 'pbkdf2-placeholder',
	usageLimited: false,
	networkLimit: [],
	walletScopeEnabled: false,
	WalletScopes: [],
});

describe('getFundDistributionEndpointGet', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockFindApiKey.mockResolvedValue(asApiKey());
		mockFindDistributions.mockResolvedValue([]);
	});

	it('filters through the target source so unassigned requests remain visible', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: getFundDistributionEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: { paymentSourceId: 'ps-1' },
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindDistributions).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					TargetWallet: expect.objectContaining({
						paymentSourceId: 'ps-1',
						PaymentSource: { network: { in: expect.arrayContaining(['Mainnet', 'Preprod']) } },
					}),
				}),
			}),
		);
	});

	it('applies source and fund-wallet filters together', async () => {
		const { responseMock } = await testEndpoint({
			endpoint: getFundDistributionEndpointGet,
			requestProps: {
				method: 'GET',
				headers: { token: 'valid' },
				query: { paymentSourceId: 'ps-1', fundWalletId: 'fund-old' },
			},
		});

		expect(responseMock.statusCode).toBe(200);
		expect(mockFindDistributions).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					fundWalletId: 'fund-old',
					TargetWallet: expect.objectContaining({ paymentSourceId: 'ps-1' }),
				}),
			}),
		);
	});
});
