import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { TransactionLayer, TransactionStatus, WebhookEventType } from '@/generated/prisma/client';

const mockQueueWebhookInTransaction = jest.fn<
	(
		tx: object,
		eventType: WebhookEventType,
		payload: object,
		entityId?: string,
		paymentSourceId?: string,
	) => Promise<void>
>(async () => undefined);

jest.unstable_mockModule('./queue.service', () => ({
	webhookQueueService: {
		queueWebhook: jest.fn(),
		queueWebhookInTransaction: mockQueueWebhookInTransaction,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		paymentRequest: {
			findUnique: jest.fn(),
		},
		purchaseRequest: {
			findUnique: jest.fn(),
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn(),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/blockchain-identifier', () => ({
	decodeBlockchainIdentifier: jest.fn(() => null),
}));

const { webhookEventsService } = await import('./events.service');

describe('transactional error webhook events', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('loads the updated payment through the transaction and queues PAYMENT_ON_ERROR', async () => {
		const createdAt = new Date('2026-07-23T00:00:00.000Z');
		const updatedAt = new Date('2026-07-23T00:01:00.000Z');
		const transaction = {
			id: 'transaction-1',
			createdAt,
			updatedAt,
			txHash: 'submitted-hash',
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			status: TransactionStatus.Pending,
			fees: 8n,
			blockHeight: null,
			blockTime: null,
			previousOnChainState: null,
			newOnChainState: null,
			confirmations: null,
			intendedTxHash: 'intended-hash',
			invalidHereafterSlot: 9n,
			l2ReservationPreviousActionId: 'action-1',
			l2ReservationPreviousTransactionId: 'previous-transaction-1',
			l2ReservationPreviousLayer: TransactionLayer.L1,
			l2ReservationPeerPreviousLayer: TransactionLayer.L2,
			l2ReservationPreviousSmartContractWalletId: 'wallet-1',
			l2ReservationPreviousBuyerReturnAddress: 'addr_test1_previous',
			l2ReservationPreviousCollateralReturn: 10n,
		};
		const payment = {
			id: 'payment-1',
			blockchainIdentifier: 'blockchain-1',
			forceLayer: TransactionLayer.L2,
			totalBuyerCardanoFees: 0n,
			totalSellerCardanoFees: 0n,
			submitResultTime: 1n,
			sellerCoolDownTime: 2n,
			buyerCoolDownTime: 3n,
			payByTime: 4n,
			unlockTime: 5n,
			externalDisputeUnlockTime: 6n,
			collateralReturnLovelace: 7n,
			currentHydraUtxoTxHash: 'live-utxo-hash',
			currentHydraUtxoOutputIndex: 0,
			currentHydraUtxoValue: [{ unit: 'lovelace', amount: '1000000' }],
			unresolvedHydraTerminalTxHash: 'unresolved-hash',
			unresolvedHydraTerminalReason: 'private reconciliation detail',
			hydraFanoutHandoffHeadId: 'head-1',
			hydraFanoutHandoffTxHash: 'fanout-hash',
			hydraFanoutHandoffOutputIndex: 2,
			RequestedFunds: [],
			WithdrawnForSeller: [],
			WithdrawnForBuyer: [],
			CurrentTransaction: transaction,
			TransactionHistory: [transaction],
			PaymentSource: {
				id: 'payment-source-1',
			},
		};
		const paymentRequestFindUnique = jest.fn<(args: object) => Promise<typeof payment>>(async () => payment);
		const tx = {
			paymentRequest: {
				findUnique: paymentRequestFindUnique,
			},
		};

		await webhookEventsService.queuePaymentOnErrorInTransaction(tx as never, 'payment-1');

		expect(paymentRequestFindUnique).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'payment-1' },
			}),
		);
		expect(mockQueueWebhookInTransaction).toHaveBeenCalledWith(
			tx,
			WebhookEventType.PAYMENT_ON_ERROR,
			expect.objectContaining({
				id: 'payment-1',
				blockchainIdentifier: 'blockchain-1',
				collateralReturnLovelace: '7',
			}),
			'blockchain-1',
			'payment-source-1',
		);

		const queuedPayload = mockQueueWebhookInTransaction.mock.calls[0]?.[2] as Record<string, unknown>;
		for (const internalField of [
			'currentHydraUtxoTxHash',
			'currentHydraUtxoOutputIndex',
			'currentHydraUtxoValue',
			'unresolvedHydraTerminalTxHash',
			'unresolvedHydraTerminalReason',
			'hydraFanoutHandoffHeadId',
			'hydraFanoutHandoffTxHash',
			'hydraFanoutHandoffOutputIndex',
		]) {
			expect(queuedPayload).not.toHaveProperty(internalField);
		}

		const publicTransaction = {
			id: 'transaction-1',
			createdAt,
			updatedAt,
			txHash: 'submitted-hash',
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			status: TransactionStatus.Pending,
			fees: '8',
			blockHeight: null,
			blockTime: null,
			previousOnChainState: null,
			newOnChainState: null,
			confirmations: null,
		};
		expect(queuedPayload.CurrentTransaction).toEqual(publicTransaction);
		expect(queuedPayload.TransactionHistory).toEqual([publicTransaction]);
	});

	it('rejects if the entity cannot be loaded so the state update also rolls back', async () => {
		const paymentRequestFindUnique = jest.fn<(args: object) => Promise<null>>(async () => null);
		const tx = {
			paymentRequest: {
				findUnique: paymentRequestFindUnique,
			},
		};

		await expect(webhookEventsService.queuePaymentOnErrorInTransaction(tx as never, 'missing')).rejects.toThrow(
			'Payment missing not found while queuing error webhook',
		);
		expect(mockQueueWebhookInTransaction).not.toHaveBeenCalled();
	});

	it('omits internal Hydra evidence from purchase webhook payloads', async () => {
		const purchase = {
			id: 'purchase-1',
			blockchainIdentifier: 'blockchain-1',
			forceLayer: null,
			paymentForceLayer: TransactionLayer.L2,
			totalBuyerCardanoFees: 0n,
			totalSellerCardanoFees: 0n,
			payByTime: 1n,
			submitResultTime: 2n,
			unlockTime: 3n,
			externalDisputeUnlockTime: 4n,
			buyerCoolDownTime: 5n,
			sellerCoolDownTime: 6n,
			collateralReturnLovelace: null,
			currentHydraUtxoTxHash: 'live-utxo-hash',
			currentHydraUtxoOutputIndex: 1,
			currentHydraUtxoValue: [{ unit: 'lovelace', amount: '2000000' }],
			unresolvedHydraTerminalTxHash: 'unresolved-hash',
			unresolvedHydraTerminalReason: 'private reconciliation detail',
			hydraFanoutHandoffHeadId: 'head-1',
			hydraFanoutHandoffTxHash: 'fanout-hash',
			hydraFanoutHandoffOutputIndex: 3,
			PaidFunds: [],
			WithdrawnForSeller: [],
			WithdrawnForBuyer: [],
			CurrentTransaction: null,
			TransactionHistory: [],
			PaymentSource: {
				id: 'payment-source-1',
			},
		};
		const purchaseRequestFindUnique = jest.fn<(args: object) => Promise<typeof purchase>>(async () => purchase);
		const tx = {
			purchaseRequest: {
				findUnique: purchaseRequestFindUnique,
			},
		};

		await webhookEventsService.queuePurchaseOnErrorInTransaction(tx as never, 'purchase-1');

		const queuedPayload = mockQueueWebhookInTransaction.mock.calls[0]?.[2] as Record<string, unknown>;
		for (const internalField of [
			'currentHydraUtxoTxHash',
			'currentHydraUtxoOutputIndex',
			'currentHydraUtxoValue',
			'unresolvedHydraTerminalTxHash',
			'unresolvedHydraTerminalReason',
			'hydraFanoutHandoffHeadId',
			'hydraFanoutHandoffTxHash',
			'hydraFanoutHandoffOutputIndex',
		]) {
			expect(queuedPayload).not.toHaveProperty(internalField);
		}
		expect(mockQueueWebhookInTransaction).toHaveBeenCalledWith(
			tx,
			WebhookEventType.PURCHASE_ON_ERROR,
			expect.objectContaining({
				id: 'purchase-1',
				paymentForceLayer: 'Hydra',
			}),
			'blockchain-1',
			'payment-source-1',
		);
	});
});
