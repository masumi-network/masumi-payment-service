import { describe, expect, it, jest } from '@jest/globals';
import type * as MeshCoreModule from '@meshsdk/core';
import { HydraHeadStatus, PaymentAction } from '@/generated/prisma/client';

const signedTx = 'signed-transaction-cbor';
const intendedTxHash = 'a'.repeat(64);
const staleT1 = new Date('2026-07-23T10:00:00.000Z');
const freshT2 = new Date('2026-07-23T10:05:01.000Z');

const walletState: { lockedAt: Date | null; pendingTransactionId: string | null } = {
	lockedAt: freshT2,
	pendingTransactionId: null,
};
let nextTransactionNumber = 0;

const mockWalletUpdateMany = jest.fn(
	async ({
		where,
		data,
	}: {
		where: { lockedAt: Date; pendingTransactionId: null };
		data: { lockedAt: Date; pendingTransactionId: string };
	}) => {
		if (
			walletState.pendingTransactionId !== where.pendingTransactionId ||
			walletState.lockedAt?.getTime() !== where.lockedAt.getTime()
		) {
			return { count: 0 };
		}
		walletState.lockedAt = data.lockedAt;
		walletState.pendingTransactionId = data.pendingTransactionId;
		return { count: 1 };
	},
);
const transactionClient = {
	$queryRaw: jest.fn(async () => [
		{ status: HydraHeadStatus.Open, isEnabled: true, isClosing: false, initTxHash: 'b'.repeat(64) },
	]),
	transaction: {
		create: jest.fn(async () => ({ id: `transaction-${++nextTransactionNumber}` })),
	},
	hotWallet: { updateMany: mockWalletUpdateMany },
	paymentRequest: {
		update: jest.fn(async () => ({ nextActionId: 'initiated-action' })),
	},
};
const mockPrismaTransaction = jest.fn(
	async (callback: (tx: typeof transactionClient) => Promise<unknown>) => await callback(transactionClient),
);
const mockFinalizeTransaction = jest.fn(async () => ({ id: 'transaction-2' }));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockPrismaTransaction,
		transaction: { update: mockFinalizeTransaction },
	},
}));
jest.unstable_mockModule('@masumi/payment-core/db-retry', () => ({
	retryOnSerializationConflict: async <T>(operation: () => Promise<T>) => await operation(),
}));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mesh = jest.requireActual<typeof MeshCoreModule>('@meshsdk/core');
jest.unstable_mockModule('@meshsdk/core', () => ({
	...mesh,
	resolveTxHash: () => intendedTxHash,
}));
jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-transaction-evidence', () => ({
	requireHydraValidityUpperSlot: () => 123n,
}));

const { submitReservedL2Action } = await import('.');

function submissionParams(walletLockedAt: Date, submitTx: (_transaction: string) => Promise<string>) {
	return {
		requestKind: 'payment' as const,
		operation: 'test-action',
		requestId: 'request-1',
		nextActionId: 'next-action-1',
		previousTransactionId: 'previous-transaction-1',
		walletId: 'wallet-1',
		walletLockedAt,
		hydraHeadId: 'head-1',
		signedTx,
		initiatedAction: PaymentAction.SubmitResultInitiated,
		retryAction: PaymentAction.SubmitResultRequested,
		submitTx,
	};
}

describe('submitReservedL2Action wallet lease', () => {
	it('rejects stale T1 after release/reacquire and lets the fresh T2 owner reserve', async () => {
		const staleSubmit = jest.fn(async (_transaction: string) => intendedTxHash);

		await expect(submitReservedL2Action(submissionParams(staleT1, staleSubmit))).rejects.toThrow(
			'L2 wallet wallet-1 was not exclusively available for test-action',
		);
		expect(staleSubmit).not.toHaveBeenCalled();
		expect(walletState).toEqual({ lockedAt: freshT2, pendingTransactionId: null });

		const freshSubmit = jest.fn(async (_transaction: string) => intendedTxHash);
		await expect(submitReservedL2Action(submissionParams(freshT2, freshSubmit))).resolves.toMatchObject({
			status: 'accepted',
			intendedTxHash,
			txHash: intendedTxHash,
		});
		expect(freshSubmit).toHaveBeenCalledWith(signedTx);
		expect(walletState.pendingTransactionId).toBe('transaction-2');
		expect(mockWalletUpdateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({ lockedAt: staleT1, pendingTransactionId: null }),
			}),
		);
		expect(mockWalletUpdateMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: expect.objectContaining({ lockedAt: freshT2, pendingTransactionId: null }),
			}),
		);
	});
});
