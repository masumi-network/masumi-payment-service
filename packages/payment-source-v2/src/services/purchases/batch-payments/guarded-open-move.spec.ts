import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GuardedHydraTransferDirection, GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { DEPOSIT_L1_GRACE_MS, WITHDRAW_SETTLE_TIMEOUT_MS } from '../../../smart-wallet/hydra-transfer';

const mockFindFirst = jest.fn<(args: { where: object; select: object }) => Promise<unknown>>();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { guardedHydraTransfer: { findFirst: mockFindFirst } },
}));

const { hasOpenGuardedMove } = await import('./guarded-open-move');

const now = new Date('2026-10-12T08:00:00Z');
const signable = {
	status: GuardedHydraTransferStatus.Prepared,
	OR: [{ signBefore: null }, { signBefore: { gt: now } }],
};

beforeEach(() => {
	jest.clearAllMocks();
	mockFindFirst.mockResolvedValue(null);
});

describe('hasOpenGuardedMove', () => {
	// A withdraw the head rejected, or one of a UTxO a purchase already spent, must not stall purchases.
	it('counts a submitted withdraw only for the held UTxO and only within the settle timeout', async () => {
		mockFindFirst.mockResolvedValue({ id: 'tr-1' });

		await expect(
			hasOpenGuardedMove({ id: 'gw-1', heldWalletUtxoRef: 'ab#0' }, GuardedHydraTransferDirection.Withdraw, now),
		).resolves.toBe(true);
		expect(mockFindFirst).toHaveBeenCalledWith({
			where: {
				guardedWalletId: 'gw-1',
				direction: GuardedHydraTransferDirection.Withdraw,
				OR: [
					{
						status: GuardedHydraTransferStatus.Submitted,
						walletUtxoRef: 'ab#0',
						submittedAt: { gt: new Date(now.getTime() - WITHDRAW_SETTLE_TIMEOUT_MS) },
					},
					signable,
				],
			},
			select: { id: true },
		});
	});

	// A lost deposit must not stall L1 purchases once it can no longer land.
	it('counts a submitted deposit only until its L1 grace ends', async () => {
		await expect(hasOpenGuardedMove({ id: 'gw-1' }, GuardedHydraTransferDirection.Deposit, now)).resolves.toBe(false);
		expect(mockFindFirst).toHaveBeenCalledWith({
			where: {
				guardedWalletId: 'gw-1',
				direction: GuardedHydraTransferDirection.Deposit,
				OR: [
					{
						status: GuardedHydraTransferStatus.Submitted,
						OR: [{ signBefore: null }, { signBefore: { gt: new Date(now.getTime() - DEPOSIT_L1_GRACE_MS) } }],
					},
					signable,
				],
			},
			select: { id: true },
		});
	});
});
