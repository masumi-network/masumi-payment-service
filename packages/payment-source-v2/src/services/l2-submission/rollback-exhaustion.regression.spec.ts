import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	HydraHeadStatus,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import { HydraTransactionRejectedError, HydraTransportAmbiguousError } from '@/lib/hydra/hydra/errors';

type Action = {
	id: string;
	requestedAction: string;
	resultHash?: string | null;
	submittedTxHash?: string | null;
	errorNote?: string | null;
};
type State = {
	nextActionId: string;
	currentTransactionId: string;
	lockedAt: Date | null;
	pendingTransactionId: string | null;
	actions: Map<string, Action>;
	actionHistory: Set<string>;
	transactionHistory: Set<string>;
	status: TransactionStatus | null;
};
type RequestUpdate = {
	where: { nextActionId?: string; currentTransactionId?: string };
	data: {
		NextAction?: { connect?: { id: string } & Partial<Action>; create?: Omit<Action, 'id'> };
		CurrentTransaction?: { connect: { id: string } };
		ActionHistory?: { connect?: { id: string }; disconnect?: { id: string } };
		TransactionHistory?: { connect?: { id: string }; disconnect?: { id: string } };
	};
};
const intendedTxHash = 'a'.repeat(64);
const leaseTime = new Date('2026-08-19T10:00:00Z');
let state: State;
let sequence = 0;

function changeHistory(history: Set<string>, mutation?: { connect?: { id: string }; disconnect?: { id: string } }) {
	if (mutation?.disconnect) history.delete(mutation.disconnect.id);
	if (mutation?.connect) history.add(mutation.connect.id);
}

async function updateRequest({ where, data }: RequestUpdate) {
	if (
		(where.nextActionId !== undefined && where.nextActionId !== state.nextActionId) ||
		(where.currentTransactionId !== undefined && where.currentTransactionId !== state.currentTransactionId)
	) {
		throw new Error('request ownership changed');
	}
	if (data.NextAction?.connect) {
		const action = state.actions.get(data.NextAction.connect.id);
		if (
			!action ||
			Object.entries(data.NextAction.connect).some(([key, value]) => action[key as keyof Action] !== value)
		) {
			throw new Error('retry action does not match');
		}
		state.nextActionId = action.id;
	}
	if (data.NextAction?.create) {
		const id = `action-${++sequence}`;
		state.actions.set(id, { id, ...data.NextAction.create });
		state.nextActionId = id;
	}
	if (data.CurrentTransaction) state.currentTransactionId = data.CurrentTransaction.connect.id;
	changeHistory(state.actionHistory, data.ActionHistory);
	changeHistory(state.transactionHistory, data.TransactionHistory);
	return { id: 'request-1', nextActionId: state.nextActionId, smartContractWalletId: 'wallet-1' };
}

const transactionClient = {
	$queryRaw: async () => [{ status: HydraHeadStatus.Open, isEnabled: true, isClosing: false, initTxHash: 'head-init' }],
	transaction: {
		create: async () => {
			state.status = TransactionStatus.Pending;
			return { id: 'reservation-1' };
		},
		update: async ({ data }: { data: { status: TransactionStatus } }) => {
			state.status = data.status;
			return { id: 'reservation-1' };
		},
	},
	hotWallet: {
		updateMany: async ({
			where,
			data,
		}: {
			where: { pendingTransactionId: string | null; lockedAt?: Date };
			data: { pendingTransactionId: string | null; lockedAt: Date | null };
		}) => {
			if (
				where.pendingTransactionId !== state.pendingTransactionId ||
				(where.lockedAt !== undefined && where.lockedAt.getTime() !== state.lockedAt?.getTime())
			)
				return { count: 0 };
			state.pendingTransactionId = data.pendingTransactionId;
			state.lockedAt = data.lockedAt;
			return { count: 1 };
		},
	},
	paymentRequest: { update: updateRequest },
	purchaseRequest: { update: updateRequest },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: async (callback: (tx: typeof transactionClient) => Promise<unknown>) => {
			const before = structuredClone(state);
			try {
				return await callback(transactionClient);
			} catch (error) {
				state = before;
				throw error;
			}
		},
	},
}));
jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async <T>(callback: () => Promise<T>) => await callback(),
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('@meshsdk/core', () => ({ resolveTxHash: () => intendedTxHash }));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-transaction-evidence', () => ({
	requireHydraValidityUpperSlot: () => 123n,
	requireHydraInputRefs: () => [`${'e'.repeat(64)}#0`],
}));
jest.unstable_mockModule('@/services/hydra-host/pause', () => ({
	isHydraHeadOnPausedHostLocked: async () => false,
}));
jest.unstable_mockModule('@/services/webhooks/events.service', () => ({
	webhookEventsService: {
		queuePaymentOnErrorInTransaction: async () => undefined,
		queuePurchaseOnErrorInTransaction: async () => undefined,
	},
}));
const transitions = await import('@/services/shared/transition-writer');
jest.unstable_mockModule('@/services/shared', () => transitions);
const { submitReservedL2Action } = await import('.');
const { writePaymentErrorTransition, writePurchaseErrorTransition } =
	await import('@/services/shared/error-transition');
const rotation = await import('../l2-queue-rotation');

beforeEach(() => {
	sequence = 0;
	state = {
		nextActionId: 'original-requested',
		currentTransactionId: 'escrow-tx',
		lockedAt: leaseTime,
		pendingTransactionId: null,
		actions: new Map(),
		actionHistory: new Set(),
		transactionHistory: new Set(),
		status: null,
	};
	rotation.clearL2Deferrals();
});

const cases = [
	['payment', PaymentAction.SubmitResultRequested, PaymentAction.SubmitResultInitiated, writePaymentErrorTransition],
	[
		'purchase',
		PurchasingAction.WithdrawRefundRequested,
		PurchasingAction.WithdrawRefundInitiated,
		writePurchaseErrorTransition,
	],
] as const;

describe.each(cases)('%s L2 safe rollback', (kind, retryAction, initiatedAction, writeFailure) => {
	function params(submitTx: () => Promise<string>) {
		return {
			requestKind: kind,
			operation: 'regression',
			requestId: 'request-1',
			nextActionId: 'original-requested',
			previousTransactionId: 'escrow-tx',
			walletId: 'wallet-1',
			walletLockedAt: leaseTime,
			hydraHeadId: 'head-1',
			signedTx: 'abcd',
			initiatedAction,
			retryAction,
			initiatedActionData: kind === 'payment' ? { resultHash: 'f'.repeat(64) } : { submittedTxHash: null },
			retryActionData: kind === 'payment' ? { resultHash: 'f'.repeat(64) } : { submittedTxHash: null },
			submitTx,
		} as Parameters<typeof submitReservedL2Action>[0];
	}

	beforeEach(() => {
		state.actions.set('original-requested', {
			id: 'original-requested',
			requestedAction: retryAction,
			...(kind === 'payment' ? { resultHash: 'f'.repeat(64) } : { submittedTxHash: null }),
			errorNote: 'original metadata',
		});
	});

	it('restores exact action data and lets exhaustion park that action', async () => {
		const original = structuredClone(state.actions.get('original-requested'));
		const result = await submitReservedL2Action(
			params(async () => {
				throw new HydraTransactionRejectedError('rejected');
			}),
		);
		expect(result.status).toBe('definitively-rejected');
		expect(state.nextActionId).toBe('original-requested');
		expect(state.actions.get('original-requested')).toEqual(original);
		expect([...state.actionHistory]).toEqual(['action-1']);
		expect(state.actions.get('action-1')?.requestedAction).toBe(initiatedAction);
		expect([...state.transactionHistory]).toEqual(['reservation-1']);
		expect(state.status).toBe(TransactionStatus.RolledBack);
		expect(state.pendingTransactionId).toBeNull();
		for (let attempt = 0; attempt < rotation.MAX_L2_ATTEMPTS - 1; attempt++)
			rotation.markL2RequestDeferred('request-1');
		await rotation.standDownL2Request('request-1', () =>
			writeFailure(transactionClient as never, {
				requestId: 'request-1',
				nextActionId: 'original-requested',
				expectedLayer: TransactionLayer.L2,
				errorNote: 'attempts exhausted',
				unlockWallet: false,
			}),
		);
		expect(state.actions.get(state.nextActionId)?.requestedAction).toBe('WaitingForManualAction');
		expect(state.actionHistory.has('original-requested')).toBe(true);
	});

	it('holds the reservation if supplied retry metadata does not match the original action', async () => {
		const submission = params(async () => {
			throw new HydraTransactionRejectedError('rejected');
		});
		submission.retryActionData = kind === 'payment' ? { resultHash: 'e'.repeat(64) } : { submittedTxHash: 'different' };
		const original = structuredClone(state.actions.get('original-requested'));
		const outcome = await submitReservedL2Action(submission);
		expect(outcome).toMatchObject({ status: 'ambiguous', phase: 'rollback' });
		expect(state.nextActionId).toBe('action-1');
		expect(state.status).toBe(TransactionStatus.Pending);
		expect(state.pendingTransactionId).toBe('reservation-1');
		expect(state.actions.get('original-requested')).toEqual(original);
	});

	it('keeps reservation and Initiated identity after ambiguous submit', async () => {
		const outcome = await submitReservedL2Action(
			params(async () => {
				throw new HydraTransportAmbiguousError('lost response');
			}),
		);
		expect(outcome.status).toBe('ambiguous');
		expect(state.nextActionId).toBe('action-1');
		expect(state.status).toBe(TransactionStatus.Pending);
		expect(state.pendingTransactionId).toBe('reservation-1');
	});

	it('does not restore over changed request ownership during rejection', async () => {
		const outcome = await submitReservedL2Action(
			params(async () => {
				state.nextActionId = 'new-owner-initiated';
				throw new HydraTransactionRejectedError('rejected');
			}),
		);
		expect(outcome).toMatchObject({ status: 'ambiguous', phase: 'rollback' });
		expect(state.nextActionId).toBe('new-owner-initiated');
		expect(state.status).toBe(TransactionStatus.Pending);
		expect(state.pendingTransactionId).toBe('reservation-1');
	});
});
