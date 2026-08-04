import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HotWalletType, PaymentSourceType, PurchasingAction } from '@/generated/prisma/client';

const mockPaymentSourceFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>().mockResolvedValue([]);
const mockResolveHead = jest.fn<(..._args: unknown[]) => Promise<unknown>>();
const mockGetProvider = jest.fn<(..._args: unknown[]) => unknown>();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentSource: { findMany: mockPaymentSourceFindMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/utils/hydra/resolve-hydra-head', () => ({
	resolveUsableHydraHeadForPurchase: mockResolveHead,
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
				PaidFunds: [],
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

beforeEach(() => {
	jest.clearAllMocks();
	mockPaymentSourceFindMany.mockResolvedValue([]);
	mockResolveHead.mockResolvedValue({ hydraHead: { id: 'head-1' } });
	mockGetProvider.mockReturnValue({});
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
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithBusyHeadWallet(new Date())]);

		await expect(processL2PurchaseLocks()).resolves.toEqual({ deferredRequestIds: ['purchase-1'] });
	});

	// The bound is what stops a permanently stuck wallet from parking purchases
	// forever: past it, L1 takes the request on its usual cadence.
	it('releases the request to L1 once the wait has gone on too long', async () => {
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithBusyHeadWallet(new Date(Date.now() - 10 * 60 * 1000))]);

		await expect(processL2PurchaseLocks()).resolves.toEqual({ deferredRequestIds: [] });
	});

	it('does not defer when no head exists for the pair', async () => {
		mockResolveHead.mockResolvedValue(null);
		mockPaymentSourceFindMany.mockResolvedValue([sourceWithBusyHeadWallet(new Date())]);

		await expect(processL2PurchaseLocks()).resolves.toEqual({ deferredRequestIds: [] });
	});
});
