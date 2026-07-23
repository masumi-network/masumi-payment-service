import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';
import { HydraHeadStatus, TransactionLayer, TransactionStatus } from '@/generated/prisma/client';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockFindLocalPlan = jest.fn() as AnyMock;
const mockFindLocal = jest.fn() as AnyMock;
const mockDeleteLocal = jest.fn() as AnyMock;
const mockDeleteSecret = jest.fn() as AnyMock;
const mockFindRemotePlan = jest.fn() as AnyMock;
const mockFindRemote = jest.fn() as AnyMock;
const mockDeleteRemote = jest.fn() as AnyMock;
const mockDeleteVerification = jest.fn() as AnyMock;
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
	hydraLocalParticipant: { findUnique: mockFindLocal, deleteMany: mockDeleteLocal },
	hydraSecretKey: { delete: mockDeleteSecret },
	hydraRemoteParticipant: { findUnique: mockFindRemote, deleteMany: mockDeleteRemote },
	hydraVerificationKey: { delete: mockDeleteVerification },
};

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		hydraLocalParticipant: { findUnique: mockFindLocalPlan },
		hydraRemoteParticipant: { findUnique: mockFindRemotePlan },
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

jest.unstable_mockModule('@/utils/security/encryption', () => ({ encrypt: (value: string) => value }));
jest.unstable_mockModule('@/lib/hydra', () => ({
	getHydraPlaintextHosts: () => [],
	validateHydraNodeUrls: (httpUrl: string, wsUrl: string) => ({ httpUrl, wsUrl }),
}));
jest.unstable_mockModule('@/lib/hydra/hydra/snapshot-verification', () => ({
	normalizeHydraSigningKeyCborHex: (value: string) => value,
	normalizeHydraVerificationKeyCborHex: (value: string) => value,
}));

let deleteHydraLocalParticipant: typeof import('./index').deleteHydraLocalParticipant;
let deleteHydraRemoteParticipant: typeof import('./index').deleteHydraRemoteParticipant;

function assignedDeletionPlan() {
	return {
		hydraHeadId: 'head-1',
		HydraHead: { hydraRelationId: 'relation-1' },
	};
}

function prismaQueryText(query: unknown): string {
	return ((query as { strings?: readonly string[] } | undefined)?.strings ?? []).join(' ');
}

function queryText(callIndex: number): string {
	return prismaQueryText(mockQueryRaw.mock.calls[callIndex]?.[0]);
}

beforeAll(async () => {
	({ deleteHydraLocalParticipant, deleteHydraRemoteParticipant } = await import('./index'));
});

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(
		async (operation: (tx: typeof transactionClient) => Promise<unknown>) => await operation(transactionClient),
	);
	mockFindLocalPlan.mockResolvedValue({ hydraHeadId: null, HydraHead: null });
	mockFindRemotePlan.mockResolvedValue({ hydraHeadId: null, HydraHead: null });
	mockQueryRaw.mockImplementation(async (query: unknown) => {
		const sql = prismaQueryText(query);
		if (sql.includes('"HydraRelation"')) return [{ id: 'relation-1' }];
		if (sql.includes('"HydraHead"')) return [{ id: 'head-1', hydraRelationId: 'relation-1' }];
		return [];
	});
	mockQuiesceHydraHeadsForDeletion.mockResolvedValue(undefined);
	mockDeleteLocal.mockResolvedValue({ count: 1 });
	mockDeleteRemote.mockResolvedValue({ count: 1 });
	mockDeleteSecret.mockResolvedValue({ id: 'local-key' });
	mockDeleteVerification.mockResolvedValue({ id: 'remote-key' });
});

describe('deleteHydraLocalParticipant', () => {
	it.each(Object.values(HydraHeadStatus).filter((status) => status !== HydraHeadStatus.Final))(
		'rejects participant deletion while its head is %s',
		async (status) => {
			mockFindLocalPlan.mockResolvedValue(assignedDeletionPlan());
			mockFindLocal.mockResolvedValue({
				hydraHeadId: 'head-1',
				hydraSecretKeyId: 'local-key',
				HydraHead: {
					status,
					isEnabled: false,
					reconciliationCompletedAt: new Date(),
					_count: { Transactions: 0 },
				},
			});

			await expect(deleteHydraLocalParticipant('local-1')).rejects.toMatchObject({ statusCode: 409 });
			expect(mockDeleteLocal).not.toHaveBeenCalled();
			expect(mockDeleteSecret).not.toHaveBeenCalled();
		},
	);

	it('deletes an unassigned participant and its owned signing key atomically', async () => {
		mockFindLocal.mockResolvedValue({
			hydraHeadId: null,
			hydraSecretKeyId: 'local-key',
			HydraHead: null,
		});

		await expect(deleteHydraLocalParticipant('local-1')).resolves.toBeUndefined();

		expect(mockTransaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' }),
		);
		expect(mockDeleteLocal).toHaveBeenCalledWith({
			where: {
				id: 'local-1',
				OR: [{ hydraHeadId: null }, { HydraHead: { is: reconciledFinalHeadFilter } }],
			},
		});
		expect(mockQuiesceHydraHeadsForDeletion).not.toHaveBeenCalled();
		expect(mockDeleteSecret).toHaveBeenCalledWith({ where: { id: 'local-key' } });
	});

	it('rejects a Final participant head until reconciliation is durably complete', async () => {
		mockFindLocalPlan.mockResolvedValue(assignedDeletionPlan());
		mockFindLocal.mockResolvedValue({
			hydraHeadId: 'head-1',
			hydraSecretKeyId: 'local-key',
			HydraHead: {
				status: HydraHeadStatus.Final,
				isEnabled: false,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: null,
				_count: { Transactions: 0 },
			},
		});

		await expect(deleteHydraLocalParticipant('local-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDeleteLocal).not.toHaveBeenCalled();
	});

	it('rejects a Final participant head that was concurrently re-enabled', async () => {
		mockFindLocalPlan.mockResolvedValue(assignedDeletionPlan());
		mockFindLocal.mockResolvedValue({
			hydraHeadId: 'head-1',
			hydraSecretKeyId: 'local-key',
			HydraHead: {
				status: HydraHeadStatus.Final,
				isEnabled: true,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		});

		await expect(deleteHydraLocalParticipant('local-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDeleteLocal).not.toHaveBeenCalled();
	});

	it('fails closed if a non-final head is attached during deletion', async () => {
		mockFindLocal.mockResolvedValue({
			hydraHeadId: null,
			hydraSecretKeyId: 'local-key',
			HydraHead: null,
		});
		mockDeleteLocal.mockResolvedValue({ count: 0 });

		await expect(deleteHydraLocalParticipant('local-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDeleteSecret).not.toHaveBeenCalled();
	});

	it('locks the relation before the local participant and head so rollback invalidation wins first', async () => {
		mockFindLocalPlan.mockResolvedValue(assignedDeletionPlan());
		mockFindLocal.mockResolvedValue({
			hydraHeadId: 'head-1',
			hydraSecretKeyId: 'local-key',
			HydraHead: {
				status: HydraHeadStatus.Final,
				isEnabled: false,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		});

		await expect(deleteHydraLocalParticipant('local-1')).resolves.toBeUndefined();

		expect(mockQueryRaw).toHaveBeenCalledTimes(3);
		expect(queryText(0)).toContain('"HydraRelation"');
		expect(queryText(1)).toContain('"HydraLocalParticipant"');
		expect(queryText(2)).toContain('"HydraHead"');
	});

	it('fails closed before participant/key deletion when the planned relation no longer locks', async () => {
		mockFindLocalPlan.mockResolvedValue(assignedDeletionPlan());
		mockQueryRaw.mockResolvedValue([]);

		await expect(deleteHydraLocalParticipant('local-1')).rejects.toMatchObject({ statusCode: 409 });

		expect(mockQueryRaw).toHaveBeenCalledTimes(1);
		expect(queryText(0)).toContain('"HydraRelation"');
		expect(mockFindLocal).not.toHaveBeenCalled();
		expect(mockDeleteLocal).not.toHaveBeenCalled();
		expect(mockDeleteSecret).not.toHaveBeenCalled();
	});
});

describe('deleteHydraRemoteParticipant', () => {
	it('rejects transport-state heads and preserves the verification key', async () => {
		mockFindRemotePlan.mockResolvedValue(assignedDeletionPlan());
		mockFindRemote.mockResolvedValue({
			hydraHeadId: 'head-1',
			hydraVerificationKeyId: 'remote-key',
			HydraHead: {
				status: HydraHeadStatus.Connected,
				isEnabled: false,
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		});

		await expect(deleteHydraRemoteParticipant('remote-1')).rejects.toMatchObject({ statusCode: 409 });
		expect(mockDeleteRemote).not.toHaveBeenCalled();
		expect(mockDeleteVerification).not.toHaveBeenCalled();
	});

	it('deletes a final-head participant and its owned verification key atomically', async () => {
		mockFindRemotePlan.mockResolvedValue(assignedDeletionPlan());
		mockFindRemote.mockResolvedValue({
			hydraHeadId: 'head-1',
			hydraVerificationKeyId: 'remote-key',
			HydraHead: {
				status: HydraHeadStatus.Final,
				isEnabled: false,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		});

		await expect(deleteHydraRemoteParticipant('remote-1')).resolves.toBeUndefined();
		expect(mockDeleteRemote).toHaveBeenCalledWith({
			where: {
				id: 'remote-1',
				OR: [{ hydraHeadId: null }, { HydraHead: { is: reconciledFinalHeadFilter } }],
			},
		});
		expect(mockQuiesceHydraHeadsForDeletion).toHaveBeenCalledWith(['head-1']);
		expect(mockDeleteVerification).toHaveBeenCalledWith({ where: { id: 'remote-key' } });
	});

	it('locks the relation before the remote participant and head so rollback invalidation wins first', async () => {
		mockFindRemotePlan.mockResolvedValue(assignedDeletionPlan());
		mockFindRemote.mockResolvedValue({
			hydraHeadId: 'head-1',
			hydraVerificationKeyId: 'remote-key',
			HydraHead: {
				status: HydraHeadStatus.Final,
				isEnabled: false,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		});

		await expect(deleteHydraRemoteParticipant('remote-1')).resolves.toBeUndefined();

		expect(mockQueryRaw).toHaveBeenCalledTimes(3);
		expect(queryText(0)).toContain('"HydraRelation"');
		expect(queryText(1)).toContain('"HydraRemoteParticipant"');
		expect(queryText(2)).toContain('"HydraHead"');
	});

	it('fails closed when the locked head was reparented after deletion preflight', async () => {
		mockFindRemotePlan.mockResolvedValue(assignedDeletionPlan());
		mockFindRemote.mockResolvedValue({
			hydraHeadId: 'head-1',
			hydraVerificationKeyId: 'remote-key',
			HydraHead: {
				status: HydraHeadStatus.Final,
				isEnabled: false,
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		});
		mockQueryRaw.mockImplementation(async (query: unknown) => {
			const sql = prismaQueryText(query);
			if (sql.includes('"HydraRelation"')) return [{ id: 'relation-1' }];
			if (sql.includes('"HydraHead"')) return [{ id: 'head-1', hydraRelationId: 'relation-2' }];
			return [];
		});

		await expect(deleteHydraRemoteParticipant('remote-1')).rejects.toMatchObject({ statusCode: 409 });

		expect(mockDeleteRemote).not.toHaveBeenCalled();
		expect(mockDeleteVerification).not.toHaveBeenCalled();
	});
});
