import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockFindRelationPlan = jest.fn() as AnyMock;
const mockFindRelation = jest.fn() as AnyMock;
const mockDeleteRelation = jest.fn() as AnyMock;
const mockDeleteSecrets = jest.fn() as AnyMock;
const mockDeleteVerificationKeys = jest.fn() as AnyMock;
const mockQuiesceHydraHeadsForDeletion = jest.fn() as AnyMock;

const reconciledFinalHeadFilter = {
	status: HydraHeadStatus.Final,
	isEnabled: false,
	fanoutTxHash: { not: null },
	reconciliationCompletedAt: { not: null },
	Transactions: {
		none: {
			layer: TransactionLayer.L2,
			OR: [
				{ status: TransactionStatus.Pending },
				{ PaymentRequestCurrent: { some: {} } },
				{ PurchaseRequestCurrent: { some: {} } },
			],
		},
	},
} as const;

const transactionClient = {
	$queryRaw: mockQueryRaw,
	hydraRelation: { findUnique: mockFindRelation, deleteMany: mockDeleteRelation },
	hydraSecretKey: { deleteMany: mockDeleteSecrets },
	hydraVerificationKey: { deleteMany: mockDeleteVerificationKeys },
};

function prismaQueryText(query: unknown): string {
	return ((query as { strings?: readonly string[] } | undefined)?.strings ?? []).join(' ');
}

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraRelation: { findUnique: mockFindRelationPlan },
		$transaction: mockTransaction,
	},
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('../deletion-guard', () => ({
	quiesceHydraHeadsForDeletion: mockQuiesceHydraHeadsForDeletion,
	reconciledFinalHeadFilter,
	unsettledL2TransactionWhere: reconciledFinalHeadFilter.Transactions.none,
}));

let deleteHydraRelation: typeof import('./index').deleteHydraRelation;

beforeAll(async () => {
	({ deleteHydraRelation } = await import('./index'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(
		async (operation: (tx: typeof transactionClient) => Promise<unknown>) => await operation(transactionClient),
	);
	mockFindRelationPlan.mockResolvedValue({ Heads: [{ id: 'head-1' }] });
	mockQueryRaw.mockResolvedValue([]);
	mockQuiesceHydraHeadsForDeletion.mockResolvedValue(undefined);
	mockDeleteRelation.mockResolvedValue({ count: 1 });
	mockDeleteSecrets.mockResolvedValue({ count: 1 });
	mockDeleteVerificationKeys.mockResolvedValue({ count: 1 });
});

describe('deleteHydraRelation', () => {
	it.each(Object.values(HydraHeadStatus).filter((status) => status !== HydraHeadStatus.Final))(
		'rejects relation deletion while an attached head is %s',
		async (status) => {
			mockFindRelation.mockResolvedValue({
				Heads: [
					{
						status,
						isEnabled: false,
						reconciliationCompletedAt: new Date(),
						_count: { Transactions: 0 },
						LocalParticipant: null,
						RemoteParticipants: [],
					},
				],
			});

			await expect(deleteHydraRelation('relation-1')).rejects.toMatchObject({ statusCode: 409 });
			expect(mockDeleteRelation).not.toHaveBeenCalled();
		},
	);

	it('deletes an all-final relation and every participant-owned key atomically', async () => {
		mockFindRelation.mockResolvedValue({
			Heads: [
				{
					status: HydraHeadStatus.Final,
					isEnabled: false,
					fanoutTxHash: 'f'.repeat(64),
					reconciliationCompletedAt: new Date(),
					_count: { Transactions: 0 },
					LocalParticipant: { hydraSecretKeyId: 'secret-1' },
					RemoteParticipants: [
						{ hydraVerificationKeyId: 'verification-1' },
						{ hydraVerificationKeyId: 'verification-2' },
					],
				},
			],
		});

		await expect(deleteHydraRelation('relation-1')).resolves.toBeUndefined();

		expect(mockTransaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' }),
		);
		expect(mockDeleteRelation).toHaveBeenCalledWith({
			where: {
				id: 'relation-1',
				Heads: { every: reconciledFinalHeadFilter },
			},
		});
		expect(mockQuiesceHydraHeadsForDeletion).toHaveBeenCalledWith(['head-1']);
		expect(mockQueryRaw).toHaveBeenCalledTimes(2);
		const headLockQuery = prismaQueryText(mockQueryRaw.mock.calls[1]?.[0]);
		expect(headLockQuery).toContain('FROM "HydraHead"');
		expect(headLockQuery).toContain('ORDER BY "id"');
		expect(headLockQuery.indexOf('ORDER BY "id"')).toBeLessThan(headLockQuery.indexOf('FOR UPDATE'));
		expect(mockDeleteSecrets).toHaveBeenCalledWith({ where: { id: { in: ['secret-1'] } } });
		expect(mockDeleteVerificationKeys).toHaveBeenCalledWith({
			where: { id: { in: ['verification-1', 'verification-2'] } },
		});
	});

	it('rejects a Final relation whose durable reconciliation marker is absent', async () => {
		mockFindRelation.mockResolvedValue({
			Heads: [
				{
					status: HydraHeadStatus.Final,
					isEnabled: false,
					fanoutTxHash: 'f'.repeat(64),
					reconciliationCompletedAt: null,
					_count: { Transactions: 0 },
					LocalParticipant: null,
					RemoteParticipants: [],
				},
			],
		});

		await expect(deleteHydraRelation('relation-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDeleteRelation).not.toHaveBeenCalled();
	});

	it('rejects a head that was concurrently re-enabled after quiescing', async () => {
		mockFindRelation.mockResolvedValue({
			Heads: [
				{
					status: HydraHeadStatus.Final,
					isEnabled: true,
					fanoutTxHash: 'f'.repeat(64),
					reconciliationCompletedAt: new Date(),
					_count: { Transactions: 0 },
					LocalParticipant: null,
					RemoteParticipants: [],
				},
			],
		});

		await expect(deleteHydraRelation('relation-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDeleteRelation).not.toHaveBeenCalled();
	});

	it('fails closed when a non-final head is attached concurrently', async () => {
		mockFindRelation.mockResolvedValue({ Heads: [] });
		mockDeleteRelation.mockResolvedValue({ count: 0 });

		await expect(deleteHydraRelation('relation-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDeleteSecrets).not.toHaveBeenCalled();
		expect(mockDeleteVerificationKeys).not.toHaveBeenCalled();
	});
});
