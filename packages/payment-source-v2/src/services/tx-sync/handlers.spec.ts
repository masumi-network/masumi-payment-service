/**
 * A V2 batch shares one Transaction row across every request it carries. The
 * first entry tx-sync confirms marks that row Confirmed, so the idempotency
 * guard cannot use the row's status alone: for a sibling whose escrow keeps its
 * state (a new result on a Disputed escrow, a second refund request), it would
 * read "already applied" before the sibling was applied, and leave it at its
 * *Initiated action for good.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { OnChainState, PaymentAction, PurchasingAction, TransactionStatus } from '@/generated/prisma/client';

type Row = {
	id: string;
	paymentSourceId: string;
	blockchainIdentifier: string;
	onChainState: OnChainState;
	currentTransactionId: string;
	nextActionId: string;
	NextAction: {
		requestedAction: string;
		errorNote: string | null;
		errorType: string | null;
		resultHash: string | null;
	};
	layer: 'L1';
};
type TxRow = {
	id: string;
	txHash: string | null;
	status: TransactionStatus;
	previousOnChainState: OnChainState | null;
	newOnChainState: OnChainState | null;
	BlocksWallet: { id: string } | null;
};

const store = { payments: new Map<string, Row>(), purchases: new Map<string, Row>(), txs: new Map<string, TxRow>() };
const updates: Array<{ table: 'payment' | 'purchase'; id: string }> = [];

function table(name: 'payment' | 'purchase') {
	const rows = name === 'payment' ? store.payments : store.purchases;
	return {
		findUnique: jest.fn(async ({ where }: { where: { blockchainIdentifier: string } }) => {
			const row = [...rows.values()].find((r) => r.blockchainIdentifier === where.blockchainIdentifier);
			if (row == null) return null;
			return { ...structuredClone(row), CurrentTransaction: structuredClone(store.txs.get(row.currentTransactionId)) };
		}),
		update: jest.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
			updates.push({ table: name, id: where.id });
			const row = rows.get(where.id)!;
			row.NextAction = { resultHash: null, ...data.NextAction.create };
			row.onChainState = data.onChainState;
			if (data.CurrentTransaction.update != null) {
				Object.assign(store.txs.get(row.currentTransactionId)!, data.CurrentTransaction.update);
			} else {
				const id = `tx-${store.txs.size + 1}`;
				store.txs.set(id, { BlocksWallet: null, ...data.CurrentTransaction.create, id });
				row.currentTransactionId = id;
			}
			return row;
		}),
	};
}

const db = {
	paymentRequest: table('payment'),
	purchaseRequest: table('purchase'),
	transaction: { update: jest.fn(async () => ({})) },
	hotWallet: { update: jest.fn(async () => ({})) },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db) },
}));
jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async (fn: () => Promise<unknown>) => fn(),
}));
jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlot: async (fn: () => Promise<unknown>) => fn(),
}));
jest.unstable_mockModule('@/utils/logic/force-layer', () => ({
	canL1ObservationOwnPaymentRequest: () => true,
	canL1ObservationOwnPurchaseRequest: () => true,
}));

let handleV2PaymentTransaction: typeof import('./handlers').handleV2PaymentTransaction;
let handleV2PurchasingTransaction: typeof import('./handlers').handleV2PurchasingTransaction;

beforeAll(async () => {
	({ handleV2PaymentTransaction, handleV2PurchasingTransaction } = await import('./handlers'));
});

const BATCH_TX = 'b'.repeat(64);
const metadata = {
	fees: 1000n,
	block_height: 1,
	block_time: 1,
	output_amount: [],
	utxo_count: 1,
	withdrawal_count: 0,
	asset_mint_or_burn_count: 0,
	redeemer_count: 3,
	valid_contract: true,
} as any;

// One Pending row shared by every request of the batch, as the batch services create it.
function batch(name: 'payment' | 'purchase', requests: Array<{ id: string; state: OnChainState; action: string }>) {
	store.txs.set('shared', {
		id: 'shared',
		txHash: BATCH_TX,
		status: TransactionStatus.Pending,
		previousOnChainState: null,
		newOnChainState: null,
		BlocksWallet: { id: 'wallet-1' },
	});
	const rows = name === 'payment' ? store.payments : store.purchases;
	for (const r of requests) {
		rows.set(r.id, {
			id: r.id,
			paymentSourceId: 'source-1',
			blockchainIdentifier: `bcid-${r.id}`,
			onChainState: r.state,
			currentTransactionId: 'shared',
			nextActionId: `action-${r.id}`,
			NextAction: { requestedAction: r.action, errorNote: null, errorType: null, resultHash: 'f'.repeat(64) },
			layer: 'L1',
		});
	}
}

// tx-sync calls the handler once per redeemer entry, in sorted input order.
const syncPayment = (id: string, newState: OnChainState) =>
	handleV2PaymentTransaction(
		BATCH_TX,
		newState,
		'source-1',
		`bcid-${id}`,
		'f'.repeat(64),
		0n,
		0n,
		[],
		[],
		3,
		metadata,
		0n,
		0n,
	);
const syncPurchase = (id: string, newState: OnChainState) =>
	handleV2PurchasingTransaction(
		BATCH_TX,
		newState,
		'source-1',
		`bcid-${id}`,
		'f'.repeat(64),
		0n,
		0n,
		[],
		[],
		3,
		metadata,
		0n,
		0n,
	);

beforeEach(() => {
	jest.clearAllMocks();
	store.payments.clear();
	store.purchases.clear();
	store.txs.clear();
	updates.length = 0;
});

describe('handleV2PaymentTransaction in a batched SubmitResult', () => {
	it('confirms every escrow that stays Disputed, not only the first one', async () => {
		batch('payment', [
			{ id: 'p1', state: OnChainState.Disputed, action: PaymentAction.SubmitResultInitiated },
			{ id: 'p2', state: OnChainState.Disputed, action: PaymentAction.SubmitResultInitiated },
			{ id: 'p3', state: OnChainState.Disputed, action: PaymentAction.SubmitResultInitiated },
		]);

		for (const id of ['p1', 'p2', 'p3']) await syncPayment(id, OnChainState.Disputed);

		for (const id of ['p1', 'p2', 'p3']) {
			expect(store.payments.get(id)!.NextAction.requestedAction).toBe(PaymentAction.WaitingForExternalAction);
		}
	});

	it('confirms a cure that comes after first deliveries in the same tx', async () => {
		batch('payment', [
			{ id: 'first-delivery', state: OnChainState.FundsLocked, action: PaymentAction.SubmitResultInitiated },
			{ id: 'cure', state: OnChainState.Disputed, action: PaymentAction.SubmitResultInitiated },
		]);

		await syncPayment('first-delivery', OnChainState.ResultSubmitted);
		await syncPayment('cure', OnChainState.Disputed);

		expect(store.payments.get('first-delivery')!.NextAction.requestedAction).toBe(
			PaymentAction.WaitingForExternalAction,
		);
		expect(store.payments.get('cure')!.NextAction.requestedAction).toBe(PaymentAction.WaitingForExternalAction);
	});

	it('still skips an entry that was already applied when the whole tx is synced again', async () => {
		batch('payment', [
			{ id: 'p1', state: OnChainState.Disputed, action: PaymentAction.SubmitResultInitiated },
			{ id: 'p2', state: OnChainState.Disputed, action: PaymentAction.SubmitResultInitiated },
		]);

		for (const id of ['p1', 'p2']) await syncPayment(id, OnChainState.Disputed);
		for (const id of ['p1', 'p2']) await syncPayment(id, OnChainState.Disputed);

		expect(updates).toEqual([
			{ table: 'payment', id: 'p1' },
			{ table: 'payment', id: 'p2' },
		]);
	});
});

describe('handleV2PurchasingTransaction in a batched SetRefundRequested', () => {
	it('confirms every escrow that stays Disputed, not only the first one', async () => {
		batch('purchase', [
			{ id: 'b1', state: OnChainState.Disputed, action: PurchasingAction.SetRefundRequestedInitiated },
			{ id: 'b2', state: OnChainState.Disputed, action: PurchasingAction.SetRefundRequestedInitiated },
		]);

		for (const id of ['b1', 'b2']) await syncPurchase(id, OnChainState.Disputed);
		for (const id of ['b1', 'b2']) await syncPurchase(id, OnChainState.Disputed);

		for (const id of ['b1', 'b2']) {
			expect(store.purchases.get(id)!.NextAction.requestedAction).toBe(PurchasingAction.WaitingForExternalAction);
		}
		expect(updates).toEqual([
			{ table: 'purchase', id: 'b1' },
			{ table: 'purchase', id: 'b2' },
		]);
	});
});
