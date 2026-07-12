import { TransactionStatus } from '@/generated/prisma/client';
import { createPendingTransaction } from './transition-writer';

describe('transition writer', () => {
	it('can persist a deterministic transaction hash when creating a pending transaction', () => {
		expect(createPendingTransaction('wallet-1', 'tx-hash-1')).toEqual({
			CurrentTransaction: {
				create: {
					txHash: 'tx-hash-1',
					status: TransactionStatus.Pending,
					BlocksWallet: {
						connect: { id: 'wallet-1' },
					},
				},
			},
		});
	});

	it('keeps the existing null-hash behavior by default', () => {
		expect(createPendingTransaction('wallet-1').CurrentTransaction.create.txHash).toBeNull();
	});
});
