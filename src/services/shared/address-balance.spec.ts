import { jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { Network } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockAddresses = jest.fn() as AnyMock;

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: jest.fn(() => ({
		addresses: mockAddresses,
	})),
}));

const { fetchAddressBalance, toBalanceMapFromAddressAmounts } = await import('./address-balance');

describe('address balance helpers', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('preserves exact bigint quantities and normalizes empty ADA units', () => {
		const balanceMap = toBalanceMapFromAddressAmounts([
			{ unit: '', quantity: '1000000' },
			{ unit: 'lovelace', quantity: '2000000' },
			{ unit: 'asset-unit', quantity: '1009494700' },
		]);

		expect(balanceMap).toEqual(
			new Map([
				['lovelace', 3000000n],
				['asset-unit', 1009494700n],
			]),
		);
	});

	it('treats a never-used address as an empty confirmed balance', async () => {
		mockAddresses.mockRejectedValueOnce({ status_code: 404, message: 'Address not found' });

		await expect(
			fetchAddressBalance({
				network: Network.Preprod,
				rpcProviderApiKey: 'provider-key',
				address: 'addr_test1unused',
			}),
		).resolves.toEqual([]);
	});

	it('does not convert provider failures into an empty balance', async () => {
		const providerError = { statusCode: 500, message: 'Provider unavailable' };
		mockAddresses.mockRejectedValueOnce(providerError);

		await expect(
			fetchAddressBalance({
				network: Network.Preprod,
				rpcProviderApiKey: 'provider-key',
				address: 'addr_test1wallet',
			}),
		).rejects.toBe(providerError);
	});
});
