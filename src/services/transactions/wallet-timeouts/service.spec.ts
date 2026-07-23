import { describe, expect, it } from '@jest/globals';
import { TransactionLayer } from '@/generated/prisma/client';
import {
	buildInvalidPendingWalletReleaseWhere,
	buildInvalidPendingWalletSweepWhere,
	isL1PendingTransaction,
} from './service';

describe('wallet-timeouts L1 cleanup boundary', () => {
	it('selects only invalid half-state wallets whose pending transaction is L1', () => {
		expect(buildInvalidPendingWalletSweepWhere()).toEqual({
			PendingTransaction: { layer: TransactionLayer.L1 },
			lockedAt: null,
			deletedAt: null,
		});
	});

	it('requires the exact L1 reservation when disconnecting an invalid half-state', () => {
		expect(buildInvalidPendingWalletReleaseWhere('wallet-1', 'transaction-1')).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			lockedAt: null,
			pendingTransactionId: 'transaction-1',
			PendingTransaction: { layer: TransactionLayer.L1 },
		});
	});

	it('rejects L2 reservations even if a widened query returns one', () => {
		expect(isL1PendingTransaction({ layer: TransactionLayer.L1 })).toBe(true);
		expect(isL1PendingTransaction({ layer: TransactionLayer.L2 })).toBe(false);
		expect(isL1PendingTransaction(null)).toBe(false);
	});
});
