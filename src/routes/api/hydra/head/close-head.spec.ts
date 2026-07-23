import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';
import { HydraCommandRejectedError, HydraTransportError } from '@/lib/hydra/hydra/errors';
import { HydraHeadInitObservationError } from '@/lib/hydra/hydra/head-init-validation';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockTransactionCount = jest.fn() as AnyMock;
const mockPaymentCount = jest.fn() as AnyMock;
const mockPurchaseCount = jest.fn() as AnyMock;
const mockClaimClose = jest.fn() as AnyMock;
const mockFindHead = jest.fn() as AnyMock;
const mockUpdateHead = jest.fn() as AnyMock;
const mockReleaseClose = jest.fn() as AnyMock;
const mockCreateHeadError = jest.fn() as AnyMock;
const mockClose = jest.fn() as AnyMock;
const mockFlushHeadStatus = jest.fn() as AnyMock;
const mockReconcileEnabledState = jest.fn() as AnyMock;

const transactionClient = {
	$queryRaw: mockQueryRaw,
	transaction: { count: mockTransactionCount },
	paymentRequest: { count: mockPaymentCount },
	purchaseRequest: { count: mockPurchaseCount },
	hydraHead: { updateMany: mockClaimClose },
};

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockTransaction,
		hydraHead: {
			findUnique: mockFindHead,
			update: mockUpdateHead,
			updateMany: mockReleaseClose,
		},
		hydraHeadError: { create: mockCreateHeadError },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => ({
		getHead: () => ({ close: mockClose }),
		flushHeadStatus: mockFlushHeadStatus,
		reconcileEnabledState: mockReconcileEnabledState,
	}),
}));

let beginHydraHeadClose: typeof import('./index').beginHydraHeadClose;
let updateHydraHeadEnabledState: typeof import('./index').updateHydraHeadEnabledState;
let closeHeadPost: typeof import('./index').closeHeadPost;
let getOrListHeadsGet: typeof import('./index').getOrListHeadsGet;

beforeAll(async () => {
	({ beginHydraHeadClose, updateHydraHeadEnabledState, closeHeadPost, getOrListHeadsGet } = await import('./index'));
});

const openHead = {
	id: 'head-1',
	status: HydraHeadStatus.Open,
	isEnabled: true,
	isClosing: false,
	initTxHash: 'a'.repeat(64),
};

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(
		async (operation: (tx: typeof transactionClient) => Promise<unknown>) => await operation(transactionClient),
	);
	mockQueryRaw.mockResolvedValue([openHead]);
	mockTransactionCount.mockResolvedValue(0);
	mockPaymentCount.mockResolvedValue(0);
	mockPurchaseCount.mockResolvedValue(0);
	mockClaimClose.mockResolvedValue({ count: 1 });
	mockFindHead.mockResolvedValue(openHead);
	mockUpdateHead.mockResolvedValue(openHead);
	mockReleaseClose.mockResolvedValue({ count: 1 });
	mockCreateHeadError.mockResolvedValue({ id: 'error-1' });
	mockClose.mockResolvedValue(undefined);
	mockFlushHeadStatus.mockResolvedValue(undefined);
	mockReconcileEnabledState.mockResolvedValue(true);
});

describe('beginHydraHeadClose', () => {
	it('rejects close while a Pending L2 reservation exists', async () => {
		mockTransactionCount.mockResolvedValue(1);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockClaimClose).not.toHaveBeenCalled();
	});

	it('rejects an Open head whose independently verified InitTx binding is absent', async () => {
		mockQueryRaw.mockResolvedValue([{ ...openHead, initTxHash: null }]);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockTransactionCount).not.toHaveBeenCalled();
		expect(mockClaimClose).not.toHaveBeenCalled();
	});

	it('blocks both exact live outputs and unresolved terminal evidence', async () => {
		mockPaymentCount.mockResolvedValue(1);

		await expect(beginHydraHeadClose('head-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockPaymentCount).toHaveBeenCalledWith({
			where: {
				layer: TransactionLayer.L2,
				CurrentTransaction: { is: { hydraHeadId: 'head-1', layer: TransactionLayer.L2 } },
				OR: [
					{
						currentHydraUtxoTxHash: { not: null },
						currentHydraUtxoOutputIndex: { not: null },
					},
					{ unresolvedHydraTerminalTxHash: { not: null } },
				],
			},
		});
		expect(mockPurchaseCount).toHaveBeenCalledWith(expect.objectContaining({ where: expect.any(Object) }));
		expect(mockClaimClose).not.toHaveBeenCalled();
	});

	it('claims the durable admission gate only after all blocking work is drained', async () => {
		await expect(beginHydraHeadClose('head-1')).resolves.toBeUndefined();

		expect(mockTransactionCount).toHaveBeenCalledWith({
			where: {
				hydraHeadId: 'head-1',
				layer: TransactionLayer.L2,
				status: TransactionStatus.Pending,
			},
		});
		expect(mockClaimClose).toHaveBeenCalledWith({
			where: {
				id: 'head-1',
				status: HydraHeadStatus.Open,
				isEnabled: true,
				isClosing: false,
				initTxHash: { not: null },
			},
			data: { isClosing: true },
		});
	});
});

describe('Hydra head state convergence', () => {
	it('does not bless an unverified InitTx as a side effect of GET', async () => {
		mockFindHead.mockResolvedValue({
			...openHead,
			headIdentifier: 'a'.repeat(56),
			initTxHash: null,
			HydraRelation: {},
		});
		const handler = (
			getOrListHeadsGet as unknown as {
				handler: (args: { input: { id: string } }) => Promise<{ heads: Array<{ initTxHash: string | null }> }>;
			}
		).handler;

		await expect(handler({ input: { id: 'head-1' } })).resolves.toMatchObject({
			heads: [{ initTxHash: null }],
		});
		expect(mockUpdateHead).not.toHaveBeenCalled();
	});

	it('clears stale InitTx admission evidence when disabling a head', async () => {
		const disabledHead = { ...openHead, isEnabled: false, initTxHash: null };
		mockUpdateHead.mockResolvedValue(disabledHead);

		await expect(updateHydraHeadEnabledState('head-1', false)).resolves.toBe(disabledHead);

		expect(mockUpdateHead).toHaveBeenCalledWith(
			expect.objectContaining({ data: { isEnabled: false, initTxHash: null } }),
		);
		expect(mockReleaseClose).not.toHaveBeenCalled();
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(1);
	});

	it('freshly verifies an established head before re-enabling and reconnecting it', async () => {
		const staleHead = {
			...openHead,
			headIdentifier: 'a'.repeat(56),
			initTxHash: 'b'.repeat(64),
			updatedAt: new Date('2026-07-23T01:00:00Z'),
			contestationPeriod: 86_400n,
			HydraRelation: {},
		};
		const quarantinedHead = {
			...staleHead,
			isEnabled: false,
			initTxHash: null,
			updatedAt: new Date('2026-07-23T01:01:00Z'),
		};
		const enabledHead = { ...quarantinedHead, isEnabled: true, initTxHash: 'c'.repeat(64) };
		mockFindHead.mockResolvedValueOnce(staleHead).mockResolvedValueOnce(enabledHead);
		mockUpdateHead.mockResolvedValue(quarantinedHead);
		const verify = jest.fn<(headId: string) => Promise<{ headIdentifier: string; initTxHash: string }>>(async () => ({
			headIdentifier: staleHead.headIdentifier,
			initTxHash: 'c'.repeat(64),
		}));

		await expect(updateHydraHeadEnabledState('head-1', true, verify)).resolves.toBe(enabledHead);

		expect(mockUpdateHead).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: 'head-1' },
				data: { isEnabled: false, initTxHash: null },
			}),
		);
		expect(verify).toHaveBeenCalledWith('head-1');
		expect(mockReleaseClose).toHaveBeenCalledWith({
			where: {
				id: 'head-1',
				isEnabled: false,
				initTxHash: null,
				updatedAt: quarantinedHead.updatedAt,
				headIdentifier: staleHead.headIdentifier,
				contestationPeriod: 86_400n,
			},
			data: { isEnabled: true, initTxHash: 'c'.repeat(64) },
		});
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(2);
	});

	it('leaves an established head disabled when fresh L1 evidence is still unavailable', async () => {
		const staleHead = {
			...openHead,
			headIdentifier: 'a'.repeat(56),
			initTxHash: 'b'.repeat(64),
			updatedAt: new Date('2026-07-23T01:00:00Z'),
			contestationPeriod: 86_400n,
			HydraRelation: {},
		};
		mockFindHead.mockResolvedValue(staleHead);
		mockUpdateHead.mockResolvedValue({
			...staleHead,
			isEnabled: false,
			initTxHash: null,
			updatedAt: new Date('2026-07-23T01:01:00Z'),
		});
		const verify = jest.fn<(headId: string) => Promise<{ headIdentifier: string; initTxHash: string }>>(async () => {
			throw new HydraHeadInitObservationError('not indexed');
		});

		await expect(updateHydraHeadEnabledState('head-1', true, verify)).rejects.toMatchObject({ statusCode: 503 });

		expect(mockReleaseClose).not.toHaveBeenCalled();
		expect(mockReconcileEnabledState).toHaveBeenCalledTimes(1);
	});

	it('keeps Close fail-closed after a post-dispatch command rejection', async () => {
		mockClose.mockRejectedValue(new HydraCommandRejectedError('Close rejected'));
		const handler = (
			closeHeadPost as unknown as {
				handler: (args: { input: { headId: string } }) => Promise<unknown>;
			}
		).handler;

		await expect(handler({ input: { headId: 'head-1' } })).rejects.toBeInstanceOf(HydraCommandRejectedError);

		expect(mockClaimClose).toHaveBeenCalled();
		expect(mockReleaseClose).not.toHaveBeenCalled();
	});

	it('releases the admission gate when the transport proves Close was never sent', async () => {
		mockClose.mockRejectedValue(new HydraTransportError('not sent'));
		const handler = (
			closeHeadPost as unknown as {
				handler: (args: { input: { headId: string } }) => Promise<unknown>;
			}
		).handler;

		await expect(handler({ input: { headId: 'head-1' } })).rejects.toBeInstanceOf(HydraTransportError);

		expect(mockReleaseClose).toHaveBeenCalledWith({
			where: { id: 'head-1', status: HydraHeadStatus.Open, isClosing: true },
			data: { isClosing: false },
		});
	});
});
