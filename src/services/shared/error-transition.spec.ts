import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PaymentAction, PurchasingAction } from '@/generated/prisma/client';

const mockQueuePaymentOnError = jest.fn<(tx: object, requestId: string) => Promise<void>>(async () => undefined);
const mockQueuePurchaseOnError = jest.fn<(tx: object, requestId: string) => Promise<void>>(async () => undefined);

jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: {
		queuePaymentOnErrorInTransaction: mockQueuePaymentOnError,
		queuePurchaseOnErrorInTransaction: mockQueuePurchaseOnError,
	},
}));

const { writePaymentErrorTransition, writePurchaseErrorTransition } = await import('./error-transition');

type UpdateArgs = { where: { id: string }; data: object };
type WalletUpdateArgs = { where: object; data: object };

function makeTx(model: 'paymentRequest' | 'purchaseRequest', walletId: string | null) {
	const requestUpdate = jest.fn<(args: UpdateArgs) => Promise<{ id: string; smartContractWalletId: string | null }>>(
		async () => ({ id: `${model}-1`, smartContractWalletId: walletId }),
	);
	const walletUpdateMany = jest.fn<(args: WalletUpdateArgs) => Promise<{ count: number }>>(async () => ({ count: 1 }));
	return {
		tx: { [model]: { update: requestUpdate }, hotWallet: { updateMany: walletUpdateMany } },
		requestUpdate,
		walletUpdateMany,
	};
}

describe('transactional error transitions', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('updates a payment and queues PAYMENT_ON_ERROR on the same transaction', async () => {
		const { tx, requestUpdate } = makeTx('paymentRequest', 'wallet-1');

		await writePaymentErrorTransition(tx as never, {
			requestId: 'payment-1',
			nextActionId: 'action-1',
			errorNote: 'Collecting payments failed',
			resultHash: 'result-hash',
		});

		expect(requestUpdate).toHaveBeenCalledWith({
			where: { id: 'payment-1' },
			data: expect.objectContaining({
				ActionHistory: { connect: { id: 'action-1' } },
				NextAction: {
					create: expect.objectContaining({
						requestedAction: PaymentAction.WaitingForManualAction,
						errorNote: 'Collecting payments failed',
						resultHash: 'result-hash',
					}),
				},
			}),
		});
		expect(mockQueuePaymentOnError).toHaveBeenCalledWith(tx, 'payment-1');
	});

	// A Hydra L1 deposit holds the same hot wallet with `lockPurpose` set across a
	// full L1 confirmation and never attaches a PendingTransaction. Clearing by
	// wallet id freed a carve mid-flight, and the next batch tick built over its
	// inputs — one of the two dies on chain as BadInputsUTxO.
	it('clears only a lock a payment path could have taken', async () => {
		const { tx, walletUpdateMany } = makeTx('paymentRequest', 'wallet-1');

		await writePaymentErrorTransition(tx as never, {
			requestId: 'payment-1',
			nextActionId: 'action-1',
			errorNote: 'Collecting payments failed',
		});

		expect(walletUpdateMany).toHaveBeenCalledWith({
			where: { id: 'wallet-1', lockPurpose: null },
			data: { lockedAt: null },
		});
	});

	it('updates a purchase and queues PURCHASE_ON_ERROR on the same transaction', async () => {
		const { tx, requestUpdate, walletUpdateMany } = makeTx('purchaseRequest', 'wallet-2');

		await writePurchaseErrorTransition(tx as never, {
			requestId: 'purchase-1',
			nextActionId: 'action-2',
			errorNote: 'Collecting refund failed',
			unlockWallet: false,
		});

		expect(requestUpdate).toHaveBeenCalledWith({
			where: { id: 'purchase-1' },
			data: expect.objectContaining({
				ActionHistory: { connect: { id: 'action-2' } },
				NextAction: {
					create: expect.objectContaining({
						requestedAction: PurchasingAction.WaitingForManualAction,
						errorNote: 'Collecting refund failed',
					}),
				},
			}),
		});
		expect(requestUpdate.mock.calls[0]?.[0].data).not.toHaveProperty('SmartContractWallet');
		expect(walletUpdateMany).not.toHaveBeenCalled();
		expect(mockQueuePurchaseOnError).toHaveBeenCalledWith(tx, 'purchase-1');
	});

	it('has nothing to unlock when the request has no wallet', async () => {
		const { tx, walletUpdateMany } = makeTx('purchaseRequest', null);

		await writePurchaseErrorTransition(tx as never, {
			requestId: 'purchase-1',
			nextActionId: 'action-2',
			errorNote: 'Collecting refund failed',
		});

		expect(walletUpdateMany).not.toHaveBeenCalled();
	});
});
