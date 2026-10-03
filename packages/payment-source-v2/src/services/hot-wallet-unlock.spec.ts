/**
 * A tick may only release the lock it took.
 *
 * The unlocker cleared `lockedAt` by wallet id. A batch's validate loop can
 * outlive `WALLET_LOCK_TIMEOUT_INTERVAL` on its own — seven items deferring
 * through a [0, 5s, 10s, 20s] schedule is 245s of sleep before any Blockfrost
 * time — so the orphan-lock reaper legitimately clears the claim, the next tick
 * takes the wallet, and the first tick then arrives at its "nothing to submit"
 * branch and frees a claim that is no longer its own. Two batches build over
 * the same UTxOs; one dies on chain as `BadInputsUTxO`, which for a script
 * spend is a phase-2 failure and burns the collateral.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockUpdateMany = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hotWallet: { updateMany: mockUpdateMany } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let makeHotWalletUnlocker: typeof import('./request-failure').makeHotWalletUnlocker;

beforeAll(async () => {
	({ makeHotWalletUnlocker } = await import('./request-failure'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe('makeHotWalletUnlocker', () => {
	it('clears only the lock the caller claimed', async () => {
		const claimedAt = new Date('2026-08-19T10:00:00.000Z');

		await makeHotWalletUnlocker('collection')('wallet-1', claimedAt);

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: { id: 'wallet-1', deletedAt: null, lockPurpose: null, lockedAt: claimedAt },
			data: { lockedAt: null },
		});
	});

	// A Hydra L1 deposit holds the same wallet with a purpose set across a full
	// L1 confirmation and never attaches a PendingTransaction.
	it('never clears a lock a payment path could not have taken', async () => {
		await makeHotWalletUnlocker('collection')('wallet-1');

		expect(mockUpdateMany.mock.calls[0]?.[0]?.where).toMatchObject({ lockPurpose: null });
	});
});
