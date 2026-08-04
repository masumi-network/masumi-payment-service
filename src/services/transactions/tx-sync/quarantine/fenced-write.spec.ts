import { jest } from '@jest/globals';
import { createPaymentSourceTxSyncFence, fencePaymentSourceTxSyncVersion, TxSyncFenceLostError } from './fenced-write';

describe('payment-source tx-sync fence', () => {
	it('uses the caller transaction for the ownership CAS', async () => {
		const updateMany = jest.fn(async () => ({ count: 1 }));
		const txdb = { paymentSource: { updateMany } } as never;

		await createPaymentSourceTxSyncFence('source-1', 7)(txdb);

		expect(updateMany).toHaveBeenCalledWith({
			where: {
				id: 'source-1',
				deletedAt: null,
				syncInProgress: true,
				txSyncFenceVersion: 7,
			},
			data: { syncInProgress: true },
		});
	});

	it('rejects a stale owner before business writes can begin', async () => {
		const txdb = {
			paymentSource: { updateMany: jest.fn(async () => ({ count: 0 })) },
		} as never;

		await expect(fencePaymentSourceTxSyncVersion(txdb, 'source-1', 6)).rejects.toBeInstanceOf(TxSyncFenceLostError);
	});
});
