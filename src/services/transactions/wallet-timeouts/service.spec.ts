import { describe, expect, it } from '@jest/globals';
import { TransactionLayer } from '@/generated/prisma/client';
import {
	buildInvalidPendingWalletReleaseWhere,
	buildInvalidPendingWalletSweepWhere,
	buildOrphanLockClearWhere,
	buildSwapUnlockWhere,
	buildTimedOutUnlockWhere,
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

// Every unlock here reads a batch, does work, then writes. Between the two a
// Hydra L1 deposit can claim the same wallet — it needs only the null columns
// these sweeps already selected on — and it holds that claim across a full L1
// confirmation with no PendingTransaction to show for it. An unfenced clear by
// wallet id frees the deposit mid-carve and the batchers spend its inputs out
// from under it. Worse, the clears that also null `lockPurpose` destroy the one
// marker that would have made the leak visible to `unstickPurposeLocks`.
describe('wallet-timeouts unlock fences', () => {
	it('clears a swap lock only for the swap the poll actually resolved', () => {
		expect(buildSwapUnlockWhere('wallet-1', 'swap-1')).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			pendingSwapTransactionId: 'swap-1',
		});
	});

	it('clears an orphan lock only while it is still unattached and unpurposed', () => {
		expect(buildOrphanLockClearWhere('wallet-1')).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			pendingTransactionId: null,
			lockPurpose: null,
		});
	});

	it('clears a timed-out lock only on the three columns it was selected by', () => {
		expect(buildTimedOutUnlockWhere('wallet-1')).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			pendingTransactionId: null,
			pendingSwapTransactionId: null,
			lockPurpose: null,
		});
	});

	// The marker is the whole point: without it in the fence, a purposed lock is
	// indistinguishable from the batcher lock these sweeps are built to reap.
	it('never lets an unlock match a wallet a Hydra L1 deposit is holding', () => {
		for (const where of [buildOrphanLockClearWhere('wallet-1'), buildTimedOutUnlockWhere('wallet-1')]) {
			expect(where.lockPurpose).toBeNull();
		}
	});
});
