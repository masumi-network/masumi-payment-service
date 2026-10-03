import { describe, expect, it } from '@jest/globals';
import { OnChainState, PurchasingAction, TransactionStatus } from '@/generated/prisma/client';
import { assertFundsLockingRetryAllowed } from './retry-guard';

describe('funds-locking retry guard', () => {
	it.each(Object.values(OnChainState))('rejects another funds lock when the observed state is %s', (state) => {
		expect(() => assertFundsLockingRetryAllowed(PurchasingAction.FundsLockingRequested, state, [])).toThrow(
			'Repair Request',
		);
	});

	it.each([
		{ status: TransactionStatus.Confirmed, txHash: 'confirmed-hash' },
		{ status: TransactionStatus.Confirmed, txHash: null },
		{ status: TransactionStatus.Pending, txHash: 'pending-hash' },
	])('rejects unresolved or confirmed submission with stale null state: %j', (transaction) => {
		expect(() => assertFundsLockingRetryAllowed(PurchasingAction.FundsLockingRequested, null, [transaction])).toThrow(
			expect.objectContaining({ statusCode: 409 }),
		);
	});

	it('allows an initial attempt with no transaction', () => {
		expect(() => assertFundsLockingRetryAllowed(PurchasingAction.FundsLockingRequested, null, [])).not.toThrow();
	});

	it.each([
		{ status: TransactionStatus.Pending, txHash: null },
		{ status: TransactionStatus.FailedViaManualReset, txHash: 'failed-hash' },
	])('allows a retry after an unbuilt or reset initial attempt: %j', (transaction) => {
		expect(() =>
			assertFundsLockingRetryAllowed(PurchasingAction.FundsLockingRequested, null, [transaction]),
		).not.toThrow();
	});

	it('does not block existing escrow actions', () => {
		expect(() =>
			assertFundsLockingRetryAllowed(PurchasingAction.SetRefundRequestedRequested, OnChainState.FundsLocked, [
				{ status: TransactionStatus.Confirmed, txHash: 'escrow-hash' },
			]),
		).not.toThrow();
	});
});
