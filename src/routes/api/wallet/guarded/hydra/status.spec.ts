import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { GuardedHydraTransferDirection, GuardedHydraTransferStatus, Network } from '@/generated/prisma/client';

type AsyncFn = (...args: unknown[]) => Promise<unknown>;
type UpdateManyArgs = { where: object; data: object };
const mockUpdateMany = jest.fn<(args: UpdateManyArgs) => Promise<{ count: number }>>();
const mockFindMany = jest.fn<AsyncFn>();
const mockFindFirst = jest.fn<AsyncFn>();
const mockLastConfirmed = jest.fn<AsyncFn>();
const mockUpdate = jest.fn<AsyncFn>();
const mockFindInHead = jest.fn<AsyncFn>();
const mockLoadGuardedHotWallet = jest.fn<AsyncFn>();
const mockInspect = jest.fn<AsyncFn>();
const mockDescribe = jest.fn<(...args: unknown[]) => unknown>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		guardedHydraTransfer: {
			updateMany: mockUpdateMany,
			findMany: mockFindMany,
			findFirst: (args: { where: { status?: string } }) =>
				args.where.status === GuardedHydraTransferStatus.Confirmed ? mockLastConfirmed(args) : mockFindFirst(args),
			update: mockUpdate,
		},
	},
}));
jest.unstable_mockModule('./location', () => ({ findGuardedWalletInHead: mockFindInHead }));
jest.unstable_mockModule('./transfers', () => ({
	loadGuardedHotWallet: mockLoadGuardedHotWallet,
	transferView: (transfer: unknown) => transfer,
}));
jest.unstable_mockModule('@masumi/payment-source-v2/smart-wallet/guarded-wallet', () => ({
	inspectGuardedWallet: mockInspect,
	describeWalletUtxo: mockDescribe,
}));

const { DEPOSIT_L1_GRACE_MS, WITHDRAW_SETTLE_TIMEOUT_MS } =
	await import('@masumi/payment-source-v2/smart-wallet/hydra-transfer');
const { getGuardedHydraStatus } = await import('./status');

const scope = { networkLimit: [Network.Preprod], walletScopeIds: null };
const params = { ownerAddress: 'addr_test1owner' };
const walletState = {
	lovelace: 10_000_000n,
	periodLimitLovelace: 5_000_000n,
	spentInPeriodLovelace: 0n,
	periodStartMs: 0n,
	periodLengthMs: 86_400_000n,
	minBalanceLovelace: 2_000_000n,
};
const unsettled = { status: GuardedHydraTransferStatus.Submitted };

function updateCalls() {
	return mockUpdateMany.mock.calls.map(([args]) => args);
}

function expectExpirySweep(call: UpdateManyArgs) {
	expect(call.where).toEqual({
		guardedWalletId: 'gw-1',
		status: GuardedHydraTransferStatus.Prepared,
		signBefore: { lte: expect.any(Date) },
	});
	expect(call.data).toEqual({ status: GuardedHydraTransferStatus.Expired });
}

// While the head holds the wallet, a withdraw of another UTxO, or one past the settle timeout, failed.
function expectStaleWithdrawSweep(call: UpdateManyArgs) {
	expect(call.where).toEqual({
		guardedWalletId: 'gw-1',
		direction: GuardedHydraTransferDirection.Withdraw,
		status: GuardedHydraTransferStatus.Submitted,
		OR: [{ walletUtxoRef: { not: IN_HEAD_REF } }, { submittedAt: { lte: expect.any(Date) } }],
	});
	expect(call.data).toMatchObject({ status: GuardedHydraTransferStatus.Failed });
	const cutoff = (call.where as { OR: [unknown, { submittedAt: { lte: Date } }] }).OR[1].submittedAt.lte;
	expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(WITHDRAW_SETTLE_TIMEOUT_MS);
}

beforeEach(() => {
	jest.clearAllMocks();
	mockLoadGuardedHotWallet.mockResolvedValue({
		hotWallet: { id: 'hw-1', PaymentSource: { PaymentSourceConfig: { rpcProviderApiKey: 'preprodKey' } } },
		guarded: { id: 'gw-1', scriptAddress: 'addr_test1script', policyId: 'p'.repeat(56) },
		params,
	});
	mockUpdateMany.mockResolvedValue({ count: 0 });
	mockFindMany.mockResolvedValue([]);
	mockFindFirst.mockResolvedValue(null);
	mockLastConfirmed.mockResolvedValue(null);
	mockUpdate.mockResolvedValue({});
});

const IN_HEAD_REF = `${'a'.repeat(64)}#1`;
const confirmed = { status: GuardedHydraTransferStatus.Confirmed, confirmedAt: expect.any(Date), failureReason: null };

describe('getGuardedHydraStatus', () => {
	it('does not confirm a deposit while the head state cannot be read', async () => {
		mockFindInHead.mockResolvedValue({
			hydraHeadId: 'head-1',
			walletUtxo: { input: { txHash: 'a'.repeat(64), outputIndex: 1 } },
			snapshot: [],
			isCommitStateKnown: false,
		});
		mockDescribe.mockReturnValue(walletState);
		mockFindFirst.mockResolvedValue({ id: 'tr-new', walletUtxoRef: IN_HEAD_REF });

		await getGuardedHydraStatus('hw-1', scope);

		expect(mockUpdate).not.toHaveBeenCalled();
		// The stale-withdraw sweep still runs; no deposit sweep does.
		expectStaleWithdrawSweep(updateCalls()[1]);
		expect(
			updateCalls().some(
				(call) => 'direction' in call.where && call.where.direction === GuardedHydraTransferDirection.Deposit,
			),
		).toBe(false);
	});

	it('confirms the newest deposit that moved the UTxO the head now holds', async () => {
		mockFindInHead.mockResolvedValue({
			hydraHeadId: 'head-1',
			walletUtxo: { input: { txHash: 'a'.repeat(64), outputIndex: 1 } },
			snapshot: [],
			isCommitStateKnown: true,
		});
		mockDescribe.mockReturnValue(walletState);
		mockFindFirst.mockResolvedValue({ id: 'tr-new', walletUtxoRef: IN_HEAD_REF });

		const result = await getGuardedHydraStatus('hw-1', scope);

		expect(mockInspect).not.toHaveBeenCalled();
		const calls = updateCalls();
		expectExpirySweep(calls[0]);
		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					guardedWalletId: 'gw-1',
					direction: GuardedHydraTransferDirection.Deposit,
					hydraHeadId: 'head-1',
					...unsettled,
				},
				orderBy: { createdAt: 'desc' },
			}),
		);
		expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'tr-new' }, data: confirmed });
		expect(calls).toHaveLength(3);
		expectStaleWithdrawSweep(calls[2]);
		expect(result).toMatchObject({
			location: 'L2',
			hydraHeadId: 'head-1',
			walletUtxoRef: IN_HEAD_REF,
			state: { lovelace: '10000000' },
			l1Error: null,
		});
	});

	// The L2 pass may lock from the wallet before anyone reads the status.
	it('confirms the deposit after an in-head purchase already moved the UTxO', async () => {
		mockFindInHead.mockResolvedValue({
			hydraHeadId: 'head-1',
			walletUtxo: { input: { txHash: 'a'.repeat(64), outputIndex: 1 } },
			snapshot: [],
			isCommitStateKnown: true,
		});
		mockDescribe.mockReturnValue(walletState);
		mockFindFirst.mockResolvedValue({ id: 'tr-dep' });

		await getGuardedHydraStatus('hw-1', scope);

		expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'tr-dep' }, data: confirmed });
	});

	it('fails a Submitted deposit to another head once the wallet sits in this one', async () => {
		mockFindInHead.mockResolvedValue({
			hydraHeadId: 'head-1',
			walletUtxo: { input: { txHash: 'a'.repeat(64), outputIndex: 1 } },
			snapshot: [],
			isCommitStateKnown: true,
		});
		mockDescribe.mockReturnValue(walletState);

		await getGuardedHydraStatus('hw-1', scope);

		expect(updateCalls()).toContainEqual({
			where: {
				guardedWalletId: 'gw-1',
				direction: GuardedHydraTransferDirection.Deposit,
				status: GuardedHydraTransferStatus.Submitted,
				hydraHeadId: { not: 'head-1' },
			},
			data: expect.objectContaining({ status: GuardedHydraTransferStatus.Failed }),
		});
	});

	it('confirms the newest withdraw and fails recovered deposits when the wallet is on L1', async () => {
		mockFindInHead.mockResolvedValue(null);
		mockInspect.mockResolvedValue(walletState);
		mockFindFirst.mockResolvedValue({ id: 'tr-w', walletUtxoRef: IN_HEAD_REF });

		const result = await getGuardedHydraStatus('hw-1', scope);

		expect(mockInspect).toHaveBeenCalledWith(params, 'preprodKey');
		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					guardedWalletId: 'gw-1',
					direction: GuardedHydraTransferDirection.Withdraw,
					hydraHeadId: undefined,
					...unsettled,
				},
			}),
		);
		expect(mockUpdate).toHaveBeenCalledWith({ where: { id: 'tr-w' }, data: confirmed });
		const calls = updateCalls();
		expect(calls).toHaveLength(2);
		expectExpirySweep(calls[0]);
		expect(calls[1].where).toEqual({
			guardedWalletId: 'gw-1',
			direction: GuardedHydraTransferDirection.Deposit,
			status: GuardedHydraTransferStatus.Submitted,
			OR: [{ recoverableAt: { lte: expect.any(Date) } }, { signBefore: { lte: expect.any(Date) } }],
		});
		expect(calls[1].data).toMatchObject({ status: GuardedHydraTransferStatus.Failed });
		// An expired deposit is called lost only after the L1 index has had time to catch up.
		const expiredBefore = (calls[1].where as { OR: [unknown, { signBefore: { lte: Date } }] }).OR[1].signBefore.lte;
		expect(Date.now() - expiredBefore.getTime()).toBeGreaterThanOrEqual(DEPOSIT_L1_GRACE_MS);
		expect(result).toMatchObject({ location: 'L1', hydraHeadId: null, walletUtxoRef: null, l1Error: null });
	});

	it('reports Unknown and confirms nothing when L1 cannot be read', async () => {
		mockFindInHead.mockResolvedValue(null);
		mockInspect.mockRejectedValue(new Error('blockfrost down'));

		const result = await getGuardedHydraStatus('hw-1', scope);

		const calls = updateCalls();
		expect(calls).toHaveLength(1);
		expectExpirySweep(calls[0]);
		expect(mockUpdate).not.toHaveBeenCalled();
		expect(result).toMatchObject({ location: 'Unknown', state: null, l1Error: 'blockfrost down' });
	});

	// A rejected withdraw stays Failed after a later one lands: it is older than the last confirmed move.
	it('only settles moves created after the last confirmed one', async () => {
		const lastConfirmedAt = new Date('2026-10-12T08:00:00Z');
		mockFindInHead.mockResolvedValue(null);
		mockInspect.mockResolvedValue(walletState);
		mockLastConfirmed.mockResolvedValue({ createdAt: lastConfirmedAt });

		await getGuardedHydraStatus('hw-1', scope);

		expect(mockFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					direction: GuardedHydraTransferDirection.Withdraw,
					createdAt: { gt: lastConfirmedAt },
				}),
			}),
		);
	});
});
