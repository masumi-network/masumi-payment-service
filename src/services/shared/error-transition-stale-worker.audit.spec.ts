import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PaymentAction, PurchasingAction, TransactionLayer } from '@/generated/prisma/client';

const queuePaymentOnError = jest.fn(async () => undefined);
const queuePurchaseOnError = jest.fn(async () => undefined);
let activeTx: object;
jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: async (callback: (tx: object) => Promise<void>) => await callback(activeTx) },
}));
jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: {
		queuePaymentOnErrorInTransaction: queuePaymentOnError,
		queuePurchaseOnErrorInTransaction: queuePurchaseOnError,
	},
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { makePaymentRequestFailureMarker, makePurchaseRequestFailureMarker } =
	await import('../../../packages/payment-source-v2/src/services/request-failure');
const { clearL2Deferrals, markL2RequestDeferred, MAX_L2_ATTEMPTS, standDownL2Request } =
	await import('../../../packages/payment-source-v2/src/services/l2-queue-rotation');

const markerConfig = { logMessage: 'Regression failure', errorNotePrefix: 'Regression: ' };
const cases = [
	['paymentRequest', PaymentAction.WithdrawInitiated, makePaymentRequestFailureMarker(markerConfig)],
	['purchaseRequest', PurchasingAction.WithdrawRefundInitiated, makePurchaseRequestFailureMarker(markerConfig)],
] as const;

function requestDatabase(model: string, action: string, layer: TransactionLayer) {
	const request = {
		id: 'request-1',
		layer,
		nextActionId: 'initiated-by-new-worker',
		NextAction: { requestedAction: action },
		currentTransactionId: 'new-worker-reservation',
		smartContractWalletId: 'wallet-1',
	};
	activeTx = {
		[model]: {
			update: async (args: {
				where: {
					id: string;
					layer?: TransactionLayer;
					nextActionId?: string;
					OR?: Array<{ layer?: TransactionLayer; nextActionId?: string }>;
				};
				data: { NextAction: { create: { requestedAction: string } } };
			}) => {
				const matchesAction = (id?: string) => id === undefined || id === request.nextActionId;
				const matchesOr =
					args.where.OR?.some(
						(condition) =>
							(condition.layer !== undefined && condition.layer === request.layer) ||
							(condition.nextActionId !== undefined && condition.nextActionId === request.nextActionId),
					) ?? true;
				if (
					!matchesAction(args.where.nextActionId) ||
					!matchesOr ||
					(args.where.layer !== undefined && args.where.layer !== request.layer)
				)
					throw new Error('P2025: request action changed');
				request.NextAction.requestedAction = args.data.NextAction.create.requestedAction;
				request.nextActionId = 'manual-action';
				return request;
			},
		},
	};
	return request;
}

beforeEach(() => {
	jest.clearAllMocks();
	clearL2Deferrals();
});

describe.each(cases)('a stale %s L2 worker reaching the attempt limit', (model, action, markFailure) => {
	it.each([TransactionLayer.L2, TransactionLayer.L1])(
		'does not park a newer reservation after stored layer becomes %s',
		async (storedLayer) => {
			clearL2Deferrals();
			const staleActionId = 'withdraw-requested-before-stale-lease';
			const request = requestDatabase(model, action, storedLayer);

			// Worker A has reached its twelfth failure. Its slow chain lookup lasted
			// past the orphan-lease timeout; worker B has since reserved the escrow.
			for (let attempt = 0; attempt < MAX_L2_ATTEMPTS - 1; attempt++) markL2RequestDeferred(request.id);
			await standDownL2Request(request.id, () =>
				markFailure(
					{ id: request.id, nextActionId: staleActionId, layer: TransactionLayer.L2 },
					new Error('old worker lookup failed'),
					{ unlockWallet: false },
				),
			);

			expect(request.NextAction.requestedAction).toBe(action);
			expect(request.nextActionId).toBe('initiated-by-new-worker');
			expect(queuePaymentOnError).not.toHaveBeenCalled();
			expect(queuePurchaseOnError).not.toHaveBeenCalled();
		},
	);

	it('does not park a handed-off L1 request even when its action identity is unchanged', async () => {
		const request = requestDatabase(model, action, TransactionLayer.L1);
		await expect(
			markFailure(
				{ id: request.id, nextActionId: request.nextActionId, layer: TransactionLayer.L2 },
				new Error('old head failed'),
				{ unlockWallet: false },
			),
		).rejects.toThrow('request action changed');
		expect(request.NextAction.requestedAction).toBe(action);
		expect(queuePaymentOnError).not.toHaveBeenCalled();
		expect(queuePurchaseOnError).not.toHaveBeenCalled();
	});

	it('keeps existing L1 fallback failure handling after its rollback created another retry action', async () => {
		const request = requestDatabase(model, action, TransactionLayer.L1);
		await markFailure(
			{ id: request.id, nextActionId: 'pre-batch-requested', layer: TransactionLayer.L1 },
			new Error('fallback failed'),
			{ unlockWallet: false },
		);
		expect(request.NextAction.requestedAction).toBe('WaitingForManualAction');
	});
});
