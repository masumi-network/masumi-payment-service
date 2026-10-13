import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HotWalletType, PaymentSourceType, PurchasingAction, TransactionLayer } from '@/generated/prisma/client';

const mockPaymentSourceFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>().mockResolvedValue([]);
const mockResolveHead = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockGetProvider = jest.fn<(..._args: unknown[]) => unknown>();
// The pass re-reads each wallet's state instead of trusting the snapshot it
// started with, so that a wallet freed mid-pass can take the next request.
const mockHotWalletFindUnique = jest
	.fn<(_args: unknown) => Promise<unknown>>()
	.mockResolvedValue({ lockedAt: null, pendingTransactionId: null });

const mockPurchaseRequestUpdate = jest.fn<(_args: unknown) => Promise<unknown>>().mockResolvedValue({});

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentSource: { findMany: mockPaymentSourceFindMany },
		hotWallet: { findUnique: mockHotWalletFindUnique },
		purchaseRequest: { update: mockPurchaseRequestUpdate },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/utils/hydra/resolve-hydra-head', () => ({
	resolveUsableHydraHeadForPurchase: mockResolveHead,
}));

// Both lock builders throw by default, the way an unbuildable lock does before
// any reservation exists, so a test only sees which one the pass chose.
const mockExecuteL2Lock = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockExecuteGuardedL2Lock = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockLocateGuardedWallet = jest.fn<(..._args: unknown[]) => Promise<unknown>>();

jest.unstable_mockModule('./l2-lock-execute', () => ({ executeL2Lock: mockExecuteL2Lock }));

jest.unstable_mockModule('./l2-guarded-lock-execute', () => ({
	executeGuardedL2Lock: mockExecuteGuardedL2Lock,
	locateGuardedWalletForLock: mockLocateGuardedWallet,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({ getProvider: mockGetProvider }),
}));

const { processL2PurchaseLocks } = await import('./l2-lock');

/** A payment source holding one auto-routed request and one busy head wallet. */
function sourceWithBusyHeadWallet(createdAt: Date) {
	return {
		id: 'source-1',
		network: 'Preprod',
		PaymentSourceConfig: {},
		PurchaseRequests: [
			{
				id: 'purchase-1',
				createdAt,
				nextActionId: 'action-1',
				sellerWalletId: 'seller-1',
				// Auto: neither side forced a layer.
				forceLayer: null,
				paymentForceLayer: null,
				PaidFunds: [{ unit: '', amount: 5_000_000n }],
				SellerWallet: { id: 'seller-1' },
				NextAction: { requestedAction: PurchasingAction.FundsLockingRequested, errorType: null },
				HotWalletLimit: null,
			},
		],
		HotWallets: [
			{
				id: 'wallet-1',
				type: HotWalletType.Purchasing,
				// Busy: it is mid-way through another lock this tick.
				lockedAt: new Date(),
				pendingTransactionId: 'tx-1',
				Secret: {},
			},
		],
	};
}

/**
 * Report the wallet as busy when the pass re-reads it.
 *
 * The snapshot above is no longer what decides: the pass re-reads each wallet
 * so one freed mid-pass can take the next request. A fixture that says busy
 * therefore has to say so in both places, or the test silently stops covering
 * the deferral it was written for.
 */
function reportWalletBusy(): void {
	mockHotWalletFindUnique.mockResolvedValue({ lockedAt: new Date(), pendingTransactionId: 'tx-1' });
}

beforeEach(() => {
	jest.clearAllMocks();
	mockPaymentSourceFindMany.mockResolvedValue([]);
	mockResolveHead.mockResolvedValue({ hydraHead: { id: 'head-1' } });
	mockGetProvider.mockReturnValue({});
	mockExecuteL2Lock.mockRejectedValue(new Error('not buildable in this test'));
	mockExecuteGuardedL2Lock.mockRejectedValue(new Error('not buildable in this test'));
	mockLocateGuardedWallet.mockResolvedValue(null);
});

describe('processL2PurchaseLocks routing scope', () => {
	it('does not route requests while their payment source is disabled or synchronizing', async () => {
		await processL2PurchaseLocks();

		expect(mockPaymentSourceFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					deletedAt: null,
					syncInProgress: false,
					disablePaymentAt: null,
					paymentSourceType: PaymentSourceType.Web3CardanoV2,
				},
			}),
		);
	});
});

/**
 * A head lock needs the one wallet that participates in that head, and that
 * wallet builds one transaction at a time. Without the deferral the L1 pass —
 * which runs moments later in the same tick — took the second of two purchases
 * created seconds apart and settled it on chain, with the head open the whole
 * time.
 */
describe('processL2PurchaseLocks deferral', () => {
	it('holds an auto request off L1 while its head wallet is busy', async () => {
		reportWalletBusy();
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithBusyHeadWallet(new Date())]);

		await expect(processL2PurchaseLocks()).resolves.toEqual({ deferredRequestIds: ['purchase-1'] });
	});

	// The bound is what stops a permanently stuck wallet from parking purchases
	// forever: past it, L1 takes the request on its usual cadence.
	it('releases the request to L1 once the wait has gone on too long', async () => {
		reportWalletBusy();
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithBusyHeadWallet(new Date(Date.now() - 10 * 60 * 1000))]);

		await expect(processL2PurchaseLocks()).resolves.toEqual({ deferredRequestIds: [] });
	});

	it('does not defer when no head exists for the pair', async () => {
		mockResolveHead.mockResolvedValue(null);
		reportWalletBusy();
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithBusyHeadWallet(new Date())]);

		await expect(processL2PurchaseLocks()).resolves.toEqual({ deferredRequestIds: [] });
	});
});

/**
 * Throughput, which is a correctness property here in the way that matters to
 * anyone watching a queue drain.
 *
 * A pass used to retire a wallet after one lock, so with a single buying wallet
 * it locked one purchase and left the rest for the next nudge — one per second,
 * against a head that confirms in milliseconds. The pass now re-reads the
 * wallet, so a freed one takes the next request immediately.
 */
describe('processL2PurchaseLocks throughput', () => {
	it('re-reads the wallet for every request instead of retiring it after one', async () => {
		mockHotWalletFindUnique.mockResolvedValue({ lockedAt: null, pendingTransactionId: null });
		const busy = sourceWithBusyHeadWallet(new Date());
		// A free wallet, and three requests waiting on it.
		const source = {
			...busy,
			HotWallets: [{ ...busy.HotWallets[0]!, lockedAt: null, pendingTransactionId: null }],
			PurchaseRequests: [
				{ ...busy.PurchaseRequests[0]!, id: 'purchase-1' },
				{ ...busy.PurchaseRequests[0]!, id: 'purchase-2' },
				{ ...busy.PurchaseRequests[0]!, id: 'purchase-3' },
			],
		};
		mockPaymentSourceFindMany.mockResolvedValue([source]);

		await processL2PurchaseLocks();

		// One read per request. Retiring the wallet after the first would have
		// stopped at one, which is the bug this covers.
		expect(mockHotWalletFindUnique.mock.calls.length).toBe(3);
	});
});

/**
 * A wallet the pass itself just used is worth waiting for; one busy for any
 * other reason is not.
 */
describe('processL2PurchaseLocks wallet waiting', () => {
	it('does not wait on a wallet that was already busy when the pass began', async () => {
		reportWalletBusy();
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithBusyHeadWallet(new Date())]);

		const startedAt = Date.now();
		await processL2PurchaseLocks();

		// Straight through: blocking here would be waiting on work this pass has
		// no part in and cannot see the end of.
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(mockHotWalletFindUnique).toHaveBeenCalled();
	});
});

/** A free guarded hot wallet and one auto-routed request waiting on it. */
function sourceWithFreeGuardedWallet() {
	mockHotWalletFindUnique.mockResolvedValue({ lockedAt: null, pendingTransactionId: null });
	const busy = sourceWithBusyHeadWallet(new Date());
	return {
		...busy,
		HotWallets: [
			{
				...busy.HotWallets[0]!,
				lockedAt: null,
				pendingTransactionId: null,
				GuardedWallet: { id: 'guarded-1', policyId: 'aa'.repeat(28), stateTokenName: 'bb', governedAsset: 'lovelace' },
			},
		],
	};
}

const walletInHead = { walletUtxo: { input: { txHash: 'cc'.repeat(32), outputIndex: 0 } }, snapshot: [] };

/**
 * A guarded wallet pays only from its smart wallet, co-signed by the quorum. In a
 * head that holds the wallet it takes the guarded builder; anywhere else it is
 * left for the L1 pass, and its own key never locks in the head.
 */
describe('processL2PurchaseLocks guarded wallets', () => {
	it('loads guarded hot wallets with their guarded wallet', async () => {
		await processL2PurchaseLocks();
		const [args] = mockPaymentSourceFindMany.mock.calls[mockPaymentSourceFindMany.mock.calls.length - 1] as [
			{ include: { HotWallets: { where: Record<string, unknown>; include: Record<string, unknown> } } },
		];
		expect(args.include.HotWallets.where).not.toHaveProperty('GuardedWallet');
		expect(args.include.HotWallets.include).toEqual(expect.objectContaining({ GuardedWallet: true }));
	});

	it('leaves the request to L1 when the head does not hold the wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithFreeGuardedWallet()]);

		await expect(processL2PurchaseLocks()).resolves.toEqual({ deferredRequestIds: [] });
		expect(mockExecuteGuardedL2Lock).not.toHaveBeenCalled();
		expect(mockExecuteL2Lock).not.toHaveBeenCalled();
	});

	it('locks through the guarded builder when the head holds the wallet', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithFreeGuardedWallet()]);
		mockLocateGuardedWallet.mockResolvedValue(walletInHead);
		mockExecuteGuardedL2Lock.mockResolvedValue({ status: 'accepted' });

		await processL2PurchaseLocks();

		expect(mockExecuteGuardedL2Lock).toHaveBeenCalledWith(
			expect.objectContaining({ hydraHeadId: 'head-1', walletUtxo: walletInHead.walletUtxo }),
		);
		expect(mockExecuteL2Lock).not.toHaveBeenCalled();
	});

	// The wallet UTxO seen before the wallet frees may be spent by then.
	it('locates the wallet again after the wallet frees', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithFreeGuardedWallet()]);
		mockLocateGuardedWallet.mockResolvedValueOnce(walletInHead).mockResolvedValueOnce(null);

		await processL2PurchaseLocks();

		expect(mockLocateGuardedWallet).toHaveBeenCalledTimes(2);
		expect(mockExecuteGuardedL2Lock).not.toHaveBeenCalled();
		expect(mockExecuteL2Lock).not.toHaveBeenCalled();
	});

	it('does not fall back to a plain lock when the quorum refuses', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithFreeGuardedWallet()]);
		mockLocateGuardedWallet.mockResolvedValue(walletInHead);
		mockExecuteGuardedL2Lock.mockResolvedValue({ status: 'cosign-refused' });

		await processL2PurchaseLocks();

		expect(mockExecuteGuardedL2Lock).toHaveBeenCalledTimes(1);
		expect(mockExecuteL2Lock).not.toHaveBeenCalled();
	});

	it('keeps a forced-Hydra request alive when the head snapshot cannot be read', async () => {
		const source = sourceWithFreeGuardedWallet();
		source.PurchaseRequests[0] = { ...source.PurchaseRequests[0]!, forceLayer: TransactionLayer.L2 as never };
		mockPaymentSourceFindMany.mockResolvedValue([source]);
		mockLocateGuardedWallet.mockRejectedValue(new Error('head unreachable'));

		await processL2PurchaseLocks();

		expect(mockPurchaseRequestUpdate).not.toHaveBeenCalled();
		expect(mockExecuteGuardedL2Lock).not.toHaveBeenCalled();
		expect(mockExecuteL2Lock).not.toHaveBeenCalled();
	});

	it('keeps a forced-Hydra request alive while the wallet is withdrawing from the head', async () => {
		const source = sourceWithFreeGuardedWallet();
		source.PurchaseRequests[0] = { ...source.PurchaseRequests[0]!, forceLayer: TransactionLayer.L2 as never };
		mockPaymentSourceFindMany.mockResolvedValue([source]);
		mockLocateGuardedWallet.mockResolvedValue('moving');

		await processL2PurchaseLocks();

		expect(mockPurchaseRequestUpdate).not.toHaveBeenCalled();
		expect(mockExecuteGuardedL2Lock).not.toHaveBeenCalled();
		expect(mockExecuteL2Lock).not.toHaveBeenCalled();
	});
	it('fails a forced-Hydra token purchase on its asset, not on a missing head', async () => {
		const source = sourceWithFreeGuardedWallet();
		source.PurchaseRequests[0] = {
			...source.PurchaseRequests[0]!,
			forceLayer: TransactionLayer.L2 as never,
			PaidFunds: [{ unit: `${'16'.repeat(28)}0014df10745553444d`, amount: 5_000_000n }],
		};
		mockPaymentSourceFindMany.mockResolvedValue([source]);

		await processL2PurchaseLocks();

		expect(mockLocateGuardedWallet).not.toHaveBeenCalled();
		expect(mockPurchaseRequestUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					NextAction: { create: expect.objectContaining({ errorNote: expect.stringContaining("purchase's asset") }) },
				}),
			}),
		);
	});
});
