import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	HydraHeadStatus,
	OnChainState,
	PaymentAction,
	PurchasingAction,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';
import {
	HydraTransactionRejectedError,
	HydraTransportAmbiguousError,
	HydraTransportError,
} from '@/lib/hydra/hydra/errors';

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
	intendedTxHash: string | null;
	invalidHereafterSlot: bigint | null;
	inputRefs: string[];
	rejectedByHeadReason: string | null;
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
let requestKind: 'payment' | 'purchase';
// A different reservation on this head can have the same intended body hash.
let collidingReservationReason: string | null;

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
		findUnique: async () => {
			const request = {
				id: 'request-1',
				nextActionId: state.nextActionId,
				NextAction: state.actions.get(state.nextActionId),
			};
			return {
				status: state.status,
				txHash: null,
				l2ReleaseNudgeTx: null,
				PurchaseRequestCurrent: requestKind === 'purchase' ? [request] : [],
				PaymentRequestCurrent: requestKind === 'payment' ? [request] : [],
			};
		},
		create: async ({
			data,
		}: {
			data: { intendedTxHash: string; invalidHereafterSlot: bigint; l2ReservationInputRefs: string[] };
		}) => {
			state.status = TransactionStatus.Pending;
			state.intendedTxHash = data.intendedTxHash;
			state.invalidHereafterSlot = data.invalidHereafterSlot;
			state.inputRefs = data.l2ReservationInputRefs;
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
		transaction: {
			updateMany: async ({
				where,
				data,
			}: {
				where: { id?: string; status: TransactionStatus };
				data: { l2RejectedByHeadReason: string };
			}) => {
				let count = 0;
				if ((where.id === undefined || where.id === 'reservation-1') && where.status === state.status) {
					state.rejectedByHeadReason = data.l2RejectedByHeadReason;
					count += 1;
				}
				if (
					(where.id === undefined || where.id === 'colliding-reservation') &&
					where.status === TransactionStatus.Pending
				) {
					collidingReservationReason = data.l2RejectedByHeadReason;
					count += 1;
				}
				return { count };
			},
		},
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
const mesh = await import('@meshsdk/core');
jest.unstable_mockModule('@meshsdk/core', () => ({ ...mesh, resolveTxHash: () => intendedTxHash }));
const evidence = await import('@/services/hydra-connection-manager/hydra-transaction-evidence');
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-transaction-evidence', () => ({
	...evidence,
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
const { prisma } = await import('@masumi/payment-core/db');
const { releaseRejectedL2Reservation } = await import('../hydra-reconcile/l2-reservation-release');
const { observationHasValidLineage } = await import('@/services/hydra-connection-manager/hydra-datum-guards');
const { writePaymentErrorTransition, writePurchaseErrorTransition } =
	await import('@/services/shared/error-transition');
const rotation = await import('../l2-queue-rotation');

beforeEach(() => {
	sequence = 0;
	collidingReservationReason = null;
	state = {
		nextActionId: 'original-requested',
		currentTransactionId: 'escrow-tx',
		lockedAt: leaseTime,
		pendingTransactionId: null,
		actions: new Map(),
		actionHistory: new Set(),
		transactionHistory: new Set(),
		status: null,
		intendedTxHash: null,
		invalidHereafterSlot: null,
		inputRefs: [],
		rejectedByHeadReason: null,
	};
	rotation.clearL2Deferrals();
});

const cases = [
	['payment', PaymentAction.SubmitResultRequested, PaymentAction.SubmitResultInitiated, writePaymentErrorTransition],
	['payment', PaymentAction.WithdrawRequested, PaymentAction.WithdrawInitiated, writePaymentErrorTransition],
	[
		'payment',
		PaymentAction.AuthorizeRefundRequested,
		PaymentAction.AuthorizeRefundInitiated,
		writePaymentErrorTransition,
	],
	[
		'purchase',
		PurchasingAction.SetRefundRequestedRequested,
		PurchasingAction.SetRefundRequestedInitiated,
		writePurchaseErrorTransition,
	],
	[
		'purchase',
		PurchasingAction.AuthorizeWithdrawalRequested,
		PurchasingAction.AuthorizeWithdrawalInitiated,
		writePurchaseErrorTransition,
	],
	[
		'purchase',
		PurchasingAction.WithdrawRefundRequested,
		PurchasingAction.WithdrawRefundInitiated,
		writePurchaseErrorTransition,
	],
] as const;

describe.each(cases)('%s %s L2 safe rollback', (kind, retryAction, initiatedAction, writeFailure) => {
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
		requestKind = kind;
		state.actions.set('original-requested', {
			id: 'original-requested',
			requestedAction: retryAction,
			...(kind === 'payment' ? { resultHash: 'f'.repeat(64) } : { submittedTxHash: null }),
			errorNote: 'original metadata',
		});
	});

	it('keeps rejected-body lineage across restart and refuses a replacement reservation', async () => {
		const submitTx = jest.fn(async (): Promise<string> => {
			throw new HydraTransactionRejectedError('rejected after dispatch');
		});
		const submission = params(submitTx);
		const outcome = await submitReservedL2Action(submission);
		expect(outcome).toMatchObject({ status: 'ambiguous', phase: 'submit', intendedTxHash });
		expect(state.status).toBe(TransactionStatus.Pending);
		expect(state.currentTransactionId).toBe('reservation-1');
		expect(state.pendingTransactionId).toBe('reservation-1');
		expect(state.actions.get(state.nextActionId)?.requestedAction).toBe(initiatedAction);
		expect(state.intendedTxHash).toBe(intendedTxHash);
		expect(state.invalidHereafterSlot).toBe(123n);
		expect(state.inputRefs).toEqual([`${'e'.repeat(64)}#0`]);
		expect(state.rejectedByHeadReason).toBe('rejected after dispatch');
		expect(collidingReservationReason).toBeNull();
		// A new process has only persisted state, with no in-memory submit outcome.
		state = structuredClone(state);
		await expect(submitReservedL2Action(submission)).rejects.toThrow(/not exclusively available/);
		expect(submitTx).toHaveBeenCalledTimes(1);
		const accepts = (txId: string) =>
			observationHasValidLineage({
				hydraHeadId: 'head-1',
				txId,
				observedState: OnChainState.ResultSubmitted,
				currentState: OnChainState.FundsLocked,
				requestLayer: TransactionLayer.L2,
				currentHydraUtxoTxHash: 'escrow-tx',
				currentHydraUtxoOutputIndex: 0,
				observedOutputReference: { txHash: txId, outputIndex: 0 },
				currentTransaction: {
					txHash: null,
					intendedTxHash: state.intendedTxHash,
					status: state.status!,
					layer: TransactionLayer.L2,
					hydraHeadId: 'head-1',
				},
				transactionHistory: [],
				initialLockSignerVkey: 'buyer',
				transactionEvidence: {
					txHash: txId,
					validityLowerSlot: 0n,
					validityUpperSlot: 123n,
					inputs: [{ txHash: 'escrow-tx', outputIndex: 0, bodyIndex: 0 }],
					spends: [],
					outputs: [],
					signerVkeys: [],
					requiredSignerVkeys: [],
				},
			});
		expect(accepts(intendedTxHash)).toBe(true);
		expect(accepts('b'.repeat(64))).toBe(false);
	});

	it('restores action state through the release helper with an explicit operator override', async () => {
		await submitReservedL2Action(
			params(async () => {
				throw new HydraTransactionRejectedError('genuine rejection');
			}),
		);
		expect(state.status).toBe(TransactionStatus.Pending);
		state = structuredClone(state);
		// This exercises only the restoration helper. The operator API's admission
		// checks are covered by operator-l2-reservation-release.spec.ts.
		await expect(
			releaseRejectedL2Reservation(
				{
					id: 'reservation-1',
					l2ReservationPreviousTransactionId: 'escrow-tx',
					l2ReservationPreviousLayer: TransactionLayer.L2,
					l2ReservationPreviousSmartContractWalletId: null,
					l2ReservationPreviousBuyerReturnAddress: null,
					l2ReservationPreviousCollateralReturn: null,
				},
				prisma,
				'operator',
			),
		).resolves.toBe(true);
		expect(state.status).toBe(TransactionStatus.RolledBack);
		expect(state.currentTransactionId).toBe('escrow-tx');
		expect(state.actions.get(state.nextActionId)?.requestedAction).toBe(retryAction);
		expect(state.pendingTransactionId).toBeNull();
	});

	it('leaves a racing confirmation intact when the submitter subsequently receives rejection', async () => {
		const outcome = await submitReservedL2Action(
			params(async () => {
				state.status = TransactionStatus.Confirmed;
				throw new HydraTransactionRejectedError('late rejection');
			}),
		);
		expect(outcome.status).toBe('ambiguous');
		expect(state.status).toBe(TransactionStatus.Confirmed);
		expect(state.currentTransactionId).toBe('reservation-1');
		expect(state.rejectedByHeadReason).toBeNull();
		expect(collidingReservationReason).toBeNull();
	});

	it('restores exact action data and lets exhaustion park that action', async () => {
		const original = structuredClone(state.actions.get('original-requested'));
		const result = await submitReservedL2Action(
			params(async () => {
				throw new HydraTransportError('not dispatched');
			}),
		);
		expect(result.status).toBe('not-dispatched');
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
			throw new HydraTransportError('not dispatched');
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

	it('does not restore over changed request ownership after a command was not dispatched', async () => {
		const outcome = await submitReservedL2Action(
			params(async () => {
				state.nextActionId = 'new-owner-initiated';
				throw new HydraTransportError('not dispatched');
			}),
		);
		expect(outcome).toMatchObject({ status: 'ambiguous', phase: 'rollback' });
		expect(state.nextActionId).toBe('new-owner-initiated');
		expect(state.status).toBe(TransactionStatus.Pending);
		expect(state.pendingTransactionId).toBe('reservation-1');
	});
});
