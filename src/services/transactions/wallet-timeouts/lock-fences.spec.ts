import { describe, expect, it } from '@jest/globals';
import { TransactionLayer } from '@/generated/prisma/client';
import {
	buildInvalidPendingWalletReleaseWhere,
	buildInvalidPendingWalletSweepWhere,
	buildOrphanLockClearWhere,
	buildSwapHalfStateClearWhere,
	buildSwapUnlockWhere,
	buildTimedOutUnlockWhere,
	isL1PendingTransaction,
} from './lock-fences';

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
const CUTOFF = new Date('2026-08-18T12:00:00.000Z');

describe('wallet-timeouts unlock fences', () => {
	it('clears a swap lock only for the swap the poll actually resolved', () => {
		expect(buildSwapUnlockWhere('wallet-1', 'swap-1')).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			pendingSwapTransactionId: 'swap-1',
		});
	});

	it('clears an orphan lock only while it is still unattached and unpurposed', () => {
		expect(buildOrphanLockClearWhere('wallet-1', CUTOFF)).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			pendingTransactionId: null,
			lockPurpose: null,
			lockedAt: { lt: CUTOFF },
		});
	});

	it('clears a timed-out lock only on the columns it was selected by', () => {
		expect(buildTimedOutUnlockWhere('wallet-1', CUTOFF)).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			pendingTransactionId: null,
			pendingSwapTransactionId: null,
			lockPurpose: null,
			lockedAt: { lt: CUTOFF },
		});
	});

	// The marker is the whole point: without it in the fence, a purposed lock is
	// indistinguishable from the batcher lock these sweeps are built to reap.
	it('never lets an unlock match a wallet a Hydra L1 deposit is holding', () => {
		for (const where of [buildOrphanLockClearWhere('wallet-1', CUTOFF), buildTimedOutUnlockWhere('wallet-1', CUTOFF)]) {
			expect(where.lockPurpose).toBeNull();
		}
	});

	// The dangerous claimant is not only the Hydra deposit. A batcher claims a
	// wallet by setting `lockedAt` and nothing else, and attaches its
	// PendingTransaction seconds later — so for those seconds it matches every
	// other column these fences name. Fencing on the age the read observed is
	// what keeps the sweep from clearing a lock that was taken after it looked.
	it('refuses to clear a lock taken after the sweep read the wallet', () => {
		for (const where of [buildOrphanLockClearWhere('wallet-1', CUTOFF), buildTimedOutUnlockWhere('wallet-1', CUTOFF)]) {
			expect(where.lockedAt).toEqual({ lt: CUTOFF });
		}
	});
	// The clear that used to be written by wallet id alone. A swap starting in the
	// gap between the read and the write attaches itself to the same wallet, and
	// clearing by id then detached a live swap from the wallet holding it.
	it('fences the swap half-state clear on the swap it read and the absent lock', () => {
		expect(buildSwapHalfStateClearWhere('wallet-1', 'swap-1')).toEqual({
			id: 'wallet-1',
			deletedAt: null,
			lockedAt: null,
			pendingSwapTransactionId: 'swap-1',
		});
	});
});
