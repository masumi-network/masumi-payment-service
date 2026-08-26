import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockFindMany = jest.fn() as AnyMock;
const mockUpdateMany = jest.fn() as AnyMock;
const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockPaymentHandoffCount = jest.fn() as AnyMock;
const mockPurchaseHandoffCount = jest.fn() as AnyMock;
const mockPaymentRequests = jest.fn() as AnyMock;
const mockPurchaseRequests = jest.fn() as AnyMock;
const mockDisconnect = jest.fn() as AnyMock;
const mockReconcileEnabledState = jest.fn() as AnyMock;
const mockLookupConfirmedChainTx = jest.fn() as AnyMock;

const cleanupHydraRelation = {
	HydraRelation: {
		network: 'Preprod',
		LocalHotWallet: {
			PaymentSource: {
				network: 'Preprod',
				PaymentSourceConfig: { rpcProviderApiKey: 'project-key' },
			},
		},
	},
};

const transactionClient = {
	$queryRaw: mockQueryRaw,
	hydraHead: { findMany: mockFindMany, updateMany: mockUpdateMany },
	paymentRequest: { count: mockPaymentHandoffCount, findMany: mockPaymentRequests },
	purchaseRequest: { count: mockPurchaseHandoffCount, findMany: mockPurchaseRequests },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockTransaction,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		disconnect: mockDisconnect,
		reconcileEnabledState: mockReconcileEnabledState,
	}),
}));

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: mockLookupConfirmedChainTx,
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 5 },
}));

let quiesceHydraHeadsForDeletion: typeof import('./deletion-guard').quiesceHydraHeadsForDeletion;
let unsettledL2TransactionWhere: typeof import('./deletion-guard').unsettledL2TransactionWhere;

beforeAll(async () => {
	({ quiesceHydraHeadsForDeletion, unsettledL2TransactionWhere } = await import('./deletion-guard'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(
		async (operation: (tx: typeof transactionClient) => Promise<unknown>) => await operation(transactionClient),
	);
	mockQueryRaw.mockResolvedValue([{ id: 'head-1' }]);
	mockFindMany.mockResolvedValue([
		{
			id: 'head-1',
			...cleanupHydraRelation,
			status: HydraHeadStatus.Final,
			fanoutTxHash: 'f'.repeat(64),
			reconciliationCompletedAt: new Date('2026-07-23T00:00:00Z'),
			_count: { Transactions: 0 },
		},
	]);
	mockPaymentHandoffCount.mockResolvedValue(0);
	mockPurchaseHandoffCount.mockResolvedValue(0);
	mockPaymentRequests.mockResolvedValue([]);
	mockPurchaseRequests.mockResolvedValue([]);
	mockUpdateMany.mockResolvedValue({ count: 1 });
	mockDisconnect.mockResolvedValue(undefined);
	mockReconcileEnabledState.mockResolvedValue(true);
	mockLookupConfirmedChainTx.mockResolvedValue('confirmed-valid');
});

describe('quiesceHydraHeadsForDeletion', () => {
	it('rejects Final heads without the durable reconciliation marker', async () => {
		mockFindMany.mockResolvedValue([
			{
				id: 'head-1',
				...cleanupHydraRelation,
				status: HydraHeadStatus.Final,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: null,
				_count: { Transactions: 0 },
			},
		]);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('rejects a reconciled head while pending L2 work remains', async () => {
		mockFindMany.mockResolvedValue([
			{
				id: 'head-1',
				...cleanupHydraRelation,
				status: HydraHeadStatus.Final,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 1 },
			},
		]);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('drains eligible evidence transports before the locked disable recheck', async () => {
		await expect(quiesceHydraHeadsForDeletion(['head-1', 'head-1'])).resolves.toBeUndefined();

		expect(mockUpdateMany).toHaveBeenCalledWith({
			where: {
				id: { in: ['head-1'] },
				status: HydraHeadStatus.Final,
				fanoutTxHash: { not: null },
				reconciliationCompletedAt: { not: null },
				Transactions: {
					none: unsettledL2TransactionWhere,
				},
			},
			data: { isEnabled: false },
		});
		expect(mockDisconnect.mock.invocationCallOrder[0]).toBeLessThan(mockUpdateMany.mock.invocationCallOrder[0]);
		expect(mockDisconnect.mock.invocationCallOrder[0]).toBeLessThan(
			mockLookupConfirmedChainTx.mock.invocationCallOrder[0],
		);
		expect(mockLookupConfirmedChainTx.mock.invocationCallOrder[0]).toBeLessThan(
			mockUpdateMany.mock.invocationCallOrder[0],
		);
		expect(mockUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
			mockReconcileEnabledState.mock.invocationCallOrder[0],
		);
		expect(mockReconcileEnabledState.mock.invocationCallOrder[0]).toBeLessThan(
			mockFindMany.mock.invocationCallOrder[2],
		);
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(1);
		expect(mockLookupConfirmedChainTx).toHaveBeenCalledWith({
			network: 'Preprod',
			rpcProviderApiKey: 'project-key',
			txHash: 'f'.repeat(64),
			requiredConfirmations: 5,
		});
	});

	it('rejects Final heads without independently confirmed fanout evidence', async () => {
		mockFindMany.mockResolvedValue([
			{
				id: 'head-1',
				status: HydraHeadStatus.Final,
				fanoutTxHash: null,
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it.each([
		['payment', mockPaymentHandoffCount],
		['purchase', mockPurchaseHandoffCount],
	] as const)('rejects while a %s fanout handoff is not adopted', async (_kind, countMock) => {
		countMock.mockResolvedValue(1);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('rejects a non-terminal request that still points at the old L2 head', async () => {
		mockPaymentRequests.mockResolvedValue([
			{
				layer: TransactionLayer.L2,
				onChainState: 'FundsLocked',
				currentHydraUtxoTxHash: null,
				currentHydraUtxoOutputIndex: null,
				currentHydraUtxoValue: null,
				unresolvedHydraTerminalTxHash: null,
				unresolvedHydraTerminalReason: null,
				hydraFanoutHandoffHeadId: null,
				hydraFanoutHandoffTxHash: null,
				hydraFanoutHandoffOutputIndex: null,
				CurrentTransaction: { status: TransactionStatus.Confirmed, txHash: 'a'.repeat(64) },
			},
		]);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('allows an exact authenticated terminal L2 audit row', async () => {
		mockPaymentRequests.mockResolvedValue([
			{
				layer: TransactionLayer.L2,
				onChainState: 'Withdrawn',
				currentHydraUtxoTxHash: null,
				currentHydraUtxoOutputIndex: null,
				currentHydraUtxoValue: null,
				unresolvedHydraTerminalTxHash: null,
				unresolvedHydraTerminalReason: null,
				hydraFanoutHandoffHeadId: null,
				hydraFanoutHandoffTxHash: null,
				hydraFanoutHandoffOutputIndex: null,
				CurrentTransaction: { status: TransactionStatus.Confirmed, txHash: 'a'.repeat(64) },
			},
		]);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).resolves.toBeUndefined();
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
	});

	it('reconnects a still-enabled head when cleanup eligibility changes after draining', async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
		expect(mockReconcileEnabledState).toHaveBeenCalledWith('head-1');
	});

	it.each([
		['pending', 409],
		['not-found', 409],
		['confirmed-invalid', 409],
		['transient-error', 503],
	] as const)('refuses deletion when fresh fanout finality is %s', async (result, statusCode) => {
		mockLookupConfirmedChainTx.mockResolvedValue(result);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode });
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockReconcileEnabledState).toHaveBeenCalledWith('head-1');
	});

	it('rejects a different fanout hash installed after the independent finality check', async () => {
		mockFindMany.mockResolvedValueOnce([
			{
				id: 'head-1',
				...cleanupHydraRelation,
				status: HydraHeadStatus.Final,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);
		mockFindMany.mockResolvedValueOnce([
			{
				id: 'head-1',
				...cleanupHydraRelation,
				status: HydraHeadStatus.Final,
				fanoutTxHash: 'e'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockUpdateMany).not.toHaveBeenCalled();
	});

	it('rejects a rollback persisted while the transport was draining', async () => {
		mockFindMany
			.mockResolvedValueOnce([
				{
					id: 'head-1',
					...cleanupHydraRelation,
					status: HydraHeadStatus.Final,
					fanoutTxHash: 'f'.repeat(64),
					reconciliationCompletedAt: new Date(),
					_count: { Transactions: 0 },
				},
			])
			.mockResolvedValueOnce([
				{
					id: 'head-1',
					status: HydraHeadStatus.Closed,
					fanoutTxHash: null,
					reconciliationCompletedAt: null,
					_count: { Transactions: 0 },
				},
			]);

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
		expect(mockUpdateMany).not.toHaveBeenCalled();
		expect(mockReconcileEnabledState).toHaveBeenCalledWith('head-1');
	});

	it('rechecks after the disabled-state drain and reconciles again when that drain persists a rollback', async () => {
		mockReconcileEnabledState.mockImplementationOnce(async () => {
			mockFindMany.mockResolvedValue([
				{
					id: 'head-1',
					...cleanupHydraRelation,
					isEnabled: false,
					status: HydraHeadStatus.Final,
					fanoutTxHash: 'f'.repeat(64),
					reconciliationCompletedAt: null,
					_count: { Transactions: 0 },
				},
			]);
			return false;
		});

		await expect(quiesceHydraHeadsForDeletion(['head-1'])).rejects.toMatchObject({ statusCode: 409 });

		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(2);
		expect(mockUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
			mockReconcileEnabledState.mock.invocationCallOrder[0],
		);
		expect(mockReconcileEnabledState.mock.invocationCallOrder[0]).toBeLessThan(
			mockFindMany.mock.invocationCallOrder[2],
		);
		expect(mockFindMany.mock.invocationCallOrder[2]).toBeLessThan(
			mockReconcileEnabledState.mock.invocationCallOrder[1],
		);
	});
});
