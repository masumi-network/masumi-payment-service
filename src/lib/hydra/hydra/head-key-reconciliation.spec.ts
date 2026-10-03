import { describe, expect, it } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { isHydraHeadKeyReconciliationEligible, type HydraHeadKeyReconciliationState } from './head-key-reconciliation';

function pristineState(): HydraHeadKeyReconciliationState {
	return {
		status: HydraHeadStatus.Idle,
		isEnabled: false,
		headIdentifier: null,
		initTxHash: null,
		closeTxHash: null,
		fanoutTxHash: null,
		openedAt: null,
		closedAt: null,
		finalizedAt: null,
		contestationDeadline: null,
		latestSnapshotNumber: 0n,
		lastReconciledSnapshotSequence: null,
		lastReconciledSnapshotTransactionIndex: null,
		reconciliationCompletedAt: null,
		isClosing: false,
		transactionCount: 0,
		errorCount: 0,
		localParticipant: {
			hasCommitted: false,
			commitTxHash: null,
			commitInvalidHereafterSlot: null,
		},
		remoteParticipants: [{ hasCommitted: false, commitTxHash: null }],
	};
}

describe('isHydraHeadKeyReconciliationEligible', () => {
	it('accepts only a disabled, pristine Idle head', () => {
		expect(isHydraHeadKeyReconciliationEligible(pristineState())).toBe(true);
	});

	it.each([
		['enabled head', { isEnabled: true }],
		['non-Idle status', { status: HydraHeadStatus.Open }],
		['head identifier', { headIdentifier: 'a'.repeat(56) }],
		['Init hash', { initTxHash: 'a'.repeat(64) }],
		['Close hash', { closeTxHash: 'b'.repeat(64) }],
		['fanout hash', { fanoutTxHash: 'c'.repeat(64) }],
		['opened timestamp', { openedAt: new Date(0) }],
		['closed timestamp', { closedAt: new Date(0) }],
		['finalized timestamp', { finalizedAt: new Date(0) }],
		['contestation deadline', { contestationDeadline: new Date(0) }],
		['snapshot number', { latestSnapshotNumber: 1n }],
		['snapshot sequence cursor', { lastReconciledSnapshotSequence: 1n }],
		['snapshot transaction cursor', { lastReconciledSnapshotTransactionIndex: 0 }],
		['reconciliation marker', { reconciliationCompletedAt: new Date(0) }],
		['close admission', { isClosing: true }],
		['transaction history', { transactionCount: 1 }],
		['head error history', { errorCount: 1 }],
	] satisfies ReadonlyArray<[string, Partial<HydraHeadKeyReconciliationState>]>)(
		'rejects a head with %s',
		(_label, change) => {
			expect(isHydraHeadKeyReconciliationEligible({ ...pristineState(), ...change })).toBe(false);
		},
	);

	it.each([
		['commit flag', { hasCommitted: true }],
		['commit hash', { commitTxHash: 'd'.repeat(64) }],
		['commit validity bound', { commitInvalidHereafterSlot: 1n }],
	] satisfies ReadonlyArray<[string, Partial<NonNullable<HydraHeadKeyReconciliationState['localParticipant']>>]>)(
		'rejects local participant %s',
		(_label, change) => {
			const state = pristineState();
			state.localParticipant = { ...state.localParticipant!, ...change };
			expect(isHydraHeadKeyReconciliationEligible(state)).toBe(false);
		},
	);

	it.each([
		['commit flag', { hasCommitted: true }],
		['commit hash', { commitTxHash: 'e'.repeat(64) }],
	] satisfies ReadonlyArray<[string, Partial<HydraHeadKeyReconciliationState['remoteParticipants'][number]>]>)(
		'rejects remote participant %s',
		(_label, change) => {
			const state = pristineState();
			state.remoteParticipants = [{ ...state.remoteParticipants[0], ...change }];
			expect(isHydraHeadKeyReconciliationEligible(state)).toBe(false);
		},
	);

	it('rejects missing or additional participants', () => {
		const missingLocal = pristineState();
		missingLocal.localParticipant = null;
		expect(isHydraHeadKeyReconciliationEligible(missingLocal)).toBe(false);

		const missingRemote = pristineState();
		missingRemote.remoteParticipants = [];
		expect(isHydraHeadKeyReconciliationEligible(missingRemote)).toBe(false);

		const additionalRemote = pristineState();
		additionalRemote.remoteParticipants = [
			{ hasCommitted: false, commitTxHash: null },
			{ hasCommitted: false, commitTxHash: null },
		];
		expect(isHydraHeadKeyReconciliationEligible(additionalRemote)).toBe(false);
	});
});
