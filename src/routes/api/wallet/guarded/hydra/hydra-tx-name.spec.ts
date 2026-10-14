import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Network } from '@/generated/prisma/client';

const mockTxsMetadata = jest.fn<(hash: string) => Promise<Array<{ label: string; json_metadata: unknown }>>>();
jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: () => ({ txsMetadata: mockTxsMetadata }),
}));

const { isHydraFanoutTx } = await import('./hydra-tx-name');

const TX = 'c'.repeat(64);

beforeEach(() => {
	jest.clearAllMocks();
});

describe('isHydraFanoutTx', () => {
	it.each(['HydraV2/FanoutTx', 'HydraV2/PartialFanoutTx', 'HydraV2/FinalPartialFanoutTx'])(
		'reads %s as a fanout',
		async (name) => {
			mockTxsMetadata.mockResolvedValue([{ label: '55555', json_metadata: name }]);
			await expect(isHydraFanoutTx(Network.Preprod, 'key', TX)).resolves.toBe(true);
			expect(mockTxsMetadata).toHaveBeenCalledWith(TX);
		},
	);

	it('does not read a decrement, a plain tx or another label as a fanout', async () => {
		mockTxsMetadata.mockResolvedValue([{ label: '55555', json_metadata: 'HydraV2/DecrementTx' }]);
		await expect(isHydraFanoutTx(Network.Preprod, 'key', TX)).resolves.toBe(false);
		mockTxsMetadata.mockResolvedValue([]);
		await expect(isHydraFanoutTx(Network.Preprod, 'key', TX)).resolves.toBe(false);
		mockTxsMetadata.mockResolvedValue([{ label: '674', json_metadata: 'HydraV2/FanoutTx' }]);
		await expect(isHydraFanoutTx(Network.Preprod, 'key', TX)).resolves.toBe(false);
	});

	it('throws when the lookup fails', async () => {
		mockTxsMetadata.mockRejectedValue(new Error('down'));
		await expect(isHydraFanoutTx(Network.Preprod, 'key', TX)).rejects.toThrow('down');
	});
});
