import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GuardedHydraTransferStatus } from '@/generated/prisma/client';
import { HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
const mockTransferUpdate = jest.fn<AsyncFn>();
const mockDecommit = jest.fn<AsyncFn>();
const mockCardanoTransaction = jest.fn<AsyncFn>();
const submitted = { id: 'tr-1', status: GuardedHydraTransferStatus.Submitted };

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule('./transfers', () => ({
	assertHotWalletIdle: () => Promise.resolve(),
	assertNoOpenTransfer: jest.fn(),
	withGuardedWalletLock: jest.fn(),
	loadGuardedHotWallet: jest.fn(),
	loadTransferToSubmit: () =>
		Promise.resolve({ id: 'tr-1', hydraHeadId: 'head-1', GuardedWallet: { hotWalletId: 'hw-1' } }),
	loadParticipantHead: () =>
		Promise.resolve({
			participant: { walletId: 'hw-1' },
			hydraHead: { decommit: mockDecommit, cardanoTransaction: mockCardanoTransaction },
		}),
	markTransferSubmitted: () => Promise.resolve(submitted),
	transactionId: jest.fn(),
	transferView: (transfer: unknown) => transfer,
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		guardedHydraTransfer: { update: mockTransferUpdate },
	},
}));

const { submitGuardedWithdraw } = await import('./withdraw');
const { submitGuardedDeposit } = await import('./deposit');

const scope = { networkLimit: [], walletScopeIds: null } as never;
const input = { transferId: 'tr-1', signedTx: '84a0' };

beforeEach(() => {
	jest.clearAllMocks();
	mockTransferUpdate.mockImplementation((args) => Promise.resolve({ id: 'tr-1', ...(args as { data: object }).data }));
});

describe.each([
	['withdraw', () => submitGuardedWithdraw(input, scope), mockDecommit],
	['deposit', () => submitGuardedDeposit(input, scope), mockCardanoTransaction],
])('submitGuarded %s', (_name, submit, send) => {
	it('leaves the transfer Submitted when the node gives no clear answer', async () => {
		send.mockRejectedValue(new HydraTransportAmbiguousError('timeout'));

		const result = await submit();

		expect(result.transfer).toBe(submitted);
		expect(mockTransferUpdate).not.toHaveBeenCalled();
	});

	it('marks the transfer Failed when the node rejects it', async () => {
		send.mockRejectedValue(new Error('400 Bad Request'));

		const result = await submit();

		expect(result.transfer).toMatchObject({
			status: GuardedHydraTransferStatus.Failed,
			failureReason: '400 Bad Request',
		});
	});
});
