import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, HydraTopupStatus, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockFindRelationPlan = jest.fn() as AnyMock;
const mockFindRelation = jest.fn() as AnyMock;
const mockDeleteRelation = jest.fn() as AnyMock;
const mockDeleteSecrets = jest.fn() as AnyMock;
const mockDeleteVerificationKeys = jest.fn() as AnyMock;
const mockQuiesceHydraHeadsForDeletion = jest.fn() as AnyMock;
const mockAssertNoUnrecoveredHydraDeposits = jest.fn() as AnyMock;
const mockWithdrawNodeFunds = jest.fn() as AnyMock;

const unrecoveredHydraTopupWhere = {
	depositTxHash: { not: null },
	status: { notIn: [HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered] },
} as const;

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
	Topups: { none: unrecoveredHydraTopupWhere },
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

jest.unstable_mockModule('@/services/hydra-node-funding/withdraw', () => ({
	withdrawNodeFunds: mockWithdrawNodeFunds,
}));

jest.unstable_mockModule('../deletion-guard', () => ({
	quiesceHydraHeadsForDeletion: mockQuiesceHydraHeadsForDeletion,
	reconciledFinalHeadFilter,
	unsettledL2TransactionWhere: reconciledFinalHeadFilter.Transactions.none,
	unrecoveredHydraTopupWhere,
	assertNoUnrecoveredHydraDeposits: mockAssertNoUnrecoveredHydraDeposits,
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
	mockFindRelationPlan.mockResolvedValue({ Heads: [{ id: 'head-1', LocalParticipant: { id: 'participant-1' } }] });
	mockWithdrawNodeFunds.mockResolvedValue({
		address: 'addr_test1node',
		balanceLovelace: '0',
		txHash: null,
		reason: null,
		code: 'dust',
	});
	mockQueryRaw.mockResolvedValue([]);
	mockQuiesceHydraHeadsForDeletion.mockResolvedValue(undefined);
	mockAssertNoUnrecoveredHydraDeposits.mockResolvedValue(undefined);
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

	// Ordering, not just the refusal: quiesce disconnects the very head a recovery
	// would have to go through, so the error's own instruction has to still be
	// followable when it is raised.
	it('refuses a relation with an unrecovered deposit before disconnecting its heads', async () => {
		mockAssertNoUnrecoveredHydraDeposits.mockRejectedValue(
			Object.assign(new Error('Cannot delete: 1 deposit(s) were never absorbed or recovered.'), {
				statusCode: 409,
			}),
		);

		await expect(deleteHydraRelation('relation-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockQuiesceHydraHeadsForDeletion).not.toHaveBeenCalled();
		expect(mockDeleteRelation).not.toHaveBeenCalled();
	});

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
	// The relation cascade deletes each head's local participant and its
	// HydraSecretKey with it, and that key's cardanoSK is the only signer for the
	// node's L1 address — which the funding cycle has been topping up since the
	// node was reserved. Deleting without sweeping left about 30 ADA per head at
	// an address nothing can sign for. The participant endpoint has always swept
	// first; this path was the one that did not.
	it('sweeps each node before the keys that can sign for it are deleted', async () => {
		mockFindRelation.mockResolvedValue({
			Heads: [
				{
					status: HydraHeadStatus.Final,
					isEnabled: false,
					fanoutTxHash: 'ab'.repeat(32),
					reconciliationCompletedAt: new Date(),
					_count: { Transactions: 0, Topups: 0 },
					LocalParticipant: { hydraSecretKeyId: 'secret-1' },
					RemoteParticipants: [],
				},
			],
		});

		await deleteHydraRelation('relation-1');

		expect(mockWithdrawNodeFunds).toHaveBeenCalledWith('participant-1');
	});

	it('refuses rather than deleting a key that still has funds behind it', async () => {
		mockWithdrawNodeFunds.mockResolvedValue({
			address: 'addr_test1node',
			balanceLovelace: '30000000',
			txHash: null,
			reason: 'the funding wallet could not be reached',
			code: 'no-funding-wallet',
		});

		await expect(deleteHydraRelation('relation-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockQuiesceHydraHeadsForDeletion).not.toHaveBeenCalled();
		expect(mockDeleteSecrets).not.toHaveBeenCalled();
	});
});
