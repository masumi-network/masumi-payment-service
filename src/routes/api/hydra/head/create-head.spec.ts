import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Mock } from 'jest-mock';

type AnyMock = Mock<(...args: any[]) => any>;

const mockTransaction = jest.fn() as AnyMock;
const mockQueryRaw = jest.fn() as AnyMock;
const mockFindRelation = jest.fn() as AnyMock;
const mockFindActiveHead = jest.fn() as AnyMock;
const mockFindFinalHeads = jest.fn() as AnyMock;
const mockPaymentHandoffCount = jest.fn() as AnyMock;
const mockPurchaseHandoffCount = jest.fn() as AnyMock;
const mockPaymentRequests = jest.fn() as AnyMock;
const mockPurchaseRequests = jest.fn() as AnyMock;
const mockCreateHead = jest.fn() as AnyMock;
const mockFindCreatedHead = jest.fn() as AnyMock;
const mockFindLocalParticipant = jest.fn() as AnyMock;
const mockClaimLocalParticipant = jest.fn() as AnyMock;
const mockFindRemoteParticipant = jest.fn() as AnyMock;
const mockClaimRemoteParticipant = jest.fn() as AnyMock;
const mockFindRelationForFanoutVerification = jest.fn() as AnyMock;
const mockLookupConfirmedChainTx = jest.fn() as AnyMock;

const transactionClient = {
	$queryRaw: mockQueryRaw,
	hydraRelation: { findUnique: mockFindRelation },
	hydraHead: {
		findFirst: mockFindActiveHead,
		findMany: mockFindFinalHeads,
		create: mockCreateHead,
		findUniqueOrThrow: mockFindCreatedHead,
	},
	paymentRequest: { count: mockPaymentHandoffCount, findMany: mockPaymentRequests },
	purchaseRequest: { count: mockPurchaseHandoffCount, findMany: mockPurchaseRequests },
	hydraLocalParticipant: {
		findUnique: mockFindLocalParticipant,
		updateMany: mockClaimLocalParticipant,
	},
	hydraRemoteParticipant: {
		findUnique: mockFindRemoteParticipant,
		updateMany: mockClaimRemoteParticipant,
	},
};

jest.unstable_mockModule('@masumi/payment-core/auth', () => ({
	adminAuthenticatedEndpointFactory: { build: (definition: unknown) => definition },
}));

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockTransaction,
		hydraRelation: { findUnique: mockFindRelationForFanoutVerification },
	},
}));

jest.unstable_mockModule('@/services/shared/chain-tx-lookup', () => ({
	lookupConfirmedChainTx: mockLookupConfirmedChainTx,
}));

jest.unstable_mockModule('@masumi/payment-core/serializable-semaphore', () => ({
	withSerializableSlotRetry: async (operation: () => Promise<unknown>) => await operation(),
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let createBoundHydraHead: typeof import('./index').createBoundHydraHead;
let createHeadSchemaInput: typeof import('./index').createHeadSchemaInput;

beforeAll(async () => {
	({ createBoundHydraHead, createHeadSchemaInput } = await import('./index'));
});

const relation = {
	id: 'relation-1',
	network: 'Preprod',
	localHotWalletId: 'local-wallet-1',
	remoteWalletId: 'remote-wallet-1',
};

const localParticipant = {
	id: 'local-participant-1',
	walletId: relation.localHotWalletId,
	hydraHeadId: null,
	Wallet: {
		deletedAt: null,
		PaymentSource: { id: 'payment-source-1', network: relation.network, deletedAt: null },
	},
};

const remoteParticipant = {
	id: 'remote-participant-1',
	walletId: relation.remoteWalletId,
	hydraHeadId: null,
	Wallet: {
		PaymentSource: { id: 'payment-source-1', network: relation.network, deletedAt: null },
	},
};

const input = {
	hydraRelationId: relation.id,
	contestationPeriod: 86_400n,
	localParticipantId: localParticipant.id,
	remoteParticipantId: remoteParticipant.id,
};

beforeEach(() => {
	jest.clearAllMocks();
	mockTransaction.mockImplementation(
		async (operation: (tx: typeof transactionClient) => Promise<unknown>) => await operation(transactionClient),
	);
	mockFindRelation.mockResolvedValue(relation);
	mockQueryRaw.mockResolvedValue([{ id: relation.id }]);
	mockFindActiveHead.mockResolvedValue(null);
	mockFindFinalHeads.mockResolvedValue([]);
	mockPaymentHandoffCount.mockResolvedValue(0);
	mockPurchaseHandoffCount.mockResolvedValue(0);
	mockPaymentRequests.mockResolvedValue([]);
	mockPurchaseRequests.mockResolvedValue([]);
	mockFindLocalParticipant.mockResolvedValue(localParticipant);
	mockFindRemoteParticipant.mockResolvedValue(remoteParticipant);
	mockCreateHead.mockResolvedValue({ id: 'head-1' });
	mockClaimLocalParticipant.mockResolvedValue({ count: 1 });
	mockClaimRemoteParticipant.mockResolvedValue({ count: 1 });
	mockFindCreatedHead.mockResolvedValue({ id: 'head-1' });
	mockFindRelationForFanoutVerification.mockImplementation(async () => ({
		network: relation.network,
		LocalHotWallet: {
			PaymentSource: {
				network: relation.network,
				PaymentSourceConfig: { rpcProviderApiKey: 'blockfrost-project-key' },
			},
		},
		Heads: await mockFindFinalHeads(),
	}));
	mockLookupConfirmedChainTx.mockResolvedValue('confirmed-valid');
});

describe('createHeadSchemaInput', () => {
	it('requires exactly one remote participant', () => {
		const base = {
			hydraRelationId: relation.id,
			localParticipantId: localParticipant.id,
		};

		expect(createHeadSchemaInput.safeParse({ ...base, remoteParticipantIds: [] }).success).toBe(false);
		expect(
			createHeadSchemaInput.safeParse({
				...base,
				remoteParticipantIds: [remoteParticipant.id, 'unrelated-participant'],
			}).success,
		).toBe(false);
		expect(createHeadSchemaInput.safeParse({ ...base, remoteParticipantIds: [remoteParticipant.id] }).success).toBe(
			true,
		);
	});
});

describe('createBoundHydraHead', () => {
	it('claims the exact relation participants in one Serializable transaction', async () => {
		await expect(createBoundHydraHead(input)).resolves.toMatchObject({ id: 'head-1' });

		expect(mockTransaction).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({ isolationLevel: 'Serializable' }),
		);
		expect(mockCreateHead).toHaveBeenCalledWith({
			data: { hydraRelationId: relation.id, contestationPeriod: input.contestationPeriod },
			select: { id: true },
		});
		expect(mockClaimLocalParticipant).toHaveBeenCalledWith({
			where: {
				id: localParticipant.id,
				walletId: relation.localHotWalletId,
				hydraHeadId: null,
			},
			data: { hydraHeadId: 'head-1' },
		});
		expect(mockClaimRemoteParticipant).toHaveBeenCalledWith({
			where: {
				id: remoteParticipant.id,
				walletId: relation.remoteWalletId,
				hydraHeadId: null,
			},
			data: { hydraHeadId: 'head-1' },
		});
	});

	it('rejects a participant belonging to another relation wallet', async () => {
		mockFindLocalParticipant.mockResolvedValue({ ...localParticipant, walletId: 'different-local-wallet' });
		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 400,
			message: 'Local participant does not belong to the Hydra relation wallet',
		});

		mockFindLocalParticipant.mockResolvedValue(localParticipant);
		mockFindRemoteParticipant.mockResolvedValue({ ...remoteParticipant, walletId: 'different-remote-wallet' });
		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 400,
			message: 'Remote participant does not belong to the Hydra relation wallet',
		});
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects a participant wallet on another network or an inactive source', async () => {
		mockFindLocalParticipant.mockResolvedValue({
			...localParticipant,
			Wallet: {
				...localParticipant.Wallet,
				PaymentSource: { id: 'payment-source-1', network: 'Mainnet', deletedAt: null },
			},
		});
		await expect(createBoundHydraHead(input)).rejects.toMatchObject({ statusCode: 400 });

		mockFindLocalParticipant.mockResolvedValue(localParticipant);
		mockFindRemoteParticipant.mockResolvedValue({
			...remoteParticipant,
			Wallet: {
				PaymentSource: { id: 'payment-source-1', network: relation.network, deletedAt: new Date() },
			},
		});
		await expect(createBoundHydraHead(input)).rejects.toMatchObject({ statusCode: 409 });
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects relation wallets from different payment sources', async () => {
		mockFindRemoteParticipant.mockResolvedValue({
			...remoteParticipant,
			Wallet: {
				PaymentSource: { id: 'payment-source-2', network: relation.network, deletedAt: null },
			},
		});

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 400,
			message: 'Hydra relation wallets must belong to the same payment source',
		});
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects a second non-final head for the relation', async () => {
		mockFindActiveHead.mockResolvedValue({ id: 'existing-head' });

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 409,
			message: 'Hydra relation already has a non-final head',
		});
		expect(mockFindLocalParticipant).not.toHaveBeenCalled();
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects replacement until every prior Final head has durable fanout proof', async () => {
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head',
				fanoutTxHash: null,
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 409,
			message: 'Previous Hydra head fanout is not independently confirmed or its L2 state is not fully adopted',
		});
		expect(mockFindLocalParticipant).not.toHaveBeenCalled();
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects replacement while a prior Final head still owns live L2 request state', async () => {
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head',
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 1 },
			},
		]);

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({ statusCode: 409 });
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it.each([
		['payment', mockPaymentHandoffCount],
		['purchase', mockPurchaseHandoffCount],
	] as const)('rejects replacement while a prior %s handoff is not adopted', async (_kind, countMock) => {
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head',
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);
		countMock.mockResolvedValue(1);

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 409,
			message: 'Previous Hydra head still has unadopted fanout handoffs',
		});
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('allows replacement after fanout proof and L1 adoption are durable', async () => {
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head',
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);

		await expect(createBoundHydraHead(input)).resolves.toMatchObject({ id: 'head-1' });
		expect(mockLookupConfirmedChainTx).toHaveBeenCalledWith({
			network: 'Preprod',
			rpcProviderApiKey: 'blockfrost-project-key',
			txHash: 'f'.repeat(64),
			requiredConfirmations: expect.any(Number),
		});
		expect(mockPaymentHandoffCount).toHaveBeenCalledWith({
			where: { hydraFanoutHandoffHeadId: { in: ['previous-head'] } },
		});
		expect(mockPurchaseHandoffCount).toHaveBeenCalledWith({
			where: { hydraFanoutHandoffHeadId: { in: ['previous-head'] } },
		});
	});

	it('freshly re-confirms every Final predecessor before creating a replacement', async () => {
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head-1',
				fanoutTxHash: 'e'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
			{
				id: 'previous-head-2',
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);

		await expect(createBoundHydraHead(input)).resolves.toMatchObject({ id: 'head-1' });
		expect(mockLookupConfirmedChainTx).toHaveBeenCalledTimes(2);
		expect(mockLookupConfirmedChainTx).toHaveBeenNthCalledWith(1, expect.objectContaining({ txHash: 'e'.repeat(64) }));
		expect(mockLookupConfirmedChainTx).toHaveBeenNthCalledWith(2, expect.objectContaining({ txHash: 'f'.repeat(64) }));
	});

	it.each(['not-found', 'pending', 'confirmed-invalid'] as const)(
		'rejects replacement when fresh L1 evidence reports %s',
		async (lookupResult) => {
			mockFindFinalHeads.mockResolvedValue([
				{
					id: 'previous-head',
					fanoutTxHash: 'f'.repeat(64),
					reconciliationCompletedAt: new Date(),
					_count: { Transactions: 0 },
				},
			]);
			mockLookupConfirmedChainTx.mockResolvedValue(lookupResult);

			await expect(createBoundHydraHead(input)).rejects.toMatchObject({
				statusCode: 409,
				message: 'Previous Hydra head fanout is no longer durably confirmed on L1',
			});
			expect(mockTransaction).not.toHaveBeenCalled();
			expect(mockCreateHead).not.toHaveBeenCalled();
		},
	);

	it('returns a retryable error when fresh L1 fanout observation is transient', async () => {
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head',
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);
		mockLookupConfirmedChainTx.mockResolvedValue('transient-error');

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 503,
			message: 'Cannot independently re-confirm previous Hydra fanout',
		});
		expect(mockTransaction).not.toHaveBeenCalled();
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects when the predecessor fanout hash changes after fresh verification but before the locked recheck', async () => {
		mockFindRelationForFanoutVerification.mockResolvedValue({
			network: relation.network,
			LocalHotWallet: {
				PaymentSource: {
					network: relation.network,
					PaymentSourceConfig: { rpcProviderApiKey: 'blockfrost-project-key' },
				},
			},
			Heads: [
				{
					id: 'previous-head',
					fanoutTxHash: 'f'.repeat(64),
					reconciliationCompletedAt: new Date(),
				},
			],
		});
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head',
				fanoutTxHash: 'e'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 409,
			message: 'Previous Hydra head fanout evidence changed during replacement verification',
		});
		expect(mockLookupConfirmedChainTx).toHaveBeenCalledWith(expect.objectContaining({ txHash: 'f'.repeat(64) }));
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects replacement when a prior head still has current L2 request ownership', async () => {
		mockFindFinalHeads.mockResolvedValue([
			{
				id: 'previous-head',
				fanoutTxHash: 'f'.repeat(64),
				reconciliationCompletedAt: new Date(),
				_count: { Transactions: 0 },
			},
		]);
		mockPurchaseRequests.mockResolvedValue([
			{
				layer: 'L1',
				onChainState: 'Withdrawn',
				currentHydraUtxoTxHash: null,
				currentHydraUtxoOutputIndex: null,
				currentHydraUtxoValue: null,
				unresolvedHydraTerminalTxHash: null,
				unresolvedHydraTerminalReason: null,
				hydraFanoutHandoffHeadId: null,
				hydraFanoutHandoffTxHash: null,
				hydraFanoutHandoffOutputIndex: null,
				CurrentTransaction: { status: 'Confirmed', txHash: 'a'.repeat(64) },
			},
		]);

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({ statusCode: 409 });
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rejects an unsafe mainnet contestation period', async () => {
		mockFindRelation.mockResolvedValue({ ...relation, network: 'Mainnet' });
		mockFindRelationForFanoutVerification.mockResolvedValue({
			network: 'Mainnet',
			LocalHotWallet: {
				PaymentSource: {
					network: 'Mainnet',
					PaymentSourceConfig: { rpcProviderApiKey: 'blockfrost-project-key' },
				},
			},
			Heads: [],
		});

		await expect(createBoundHydraHead({ ...input, contestationPeriod: 43_199n })).rejects.toMatchObject({
			statusCode: 400,
			message: 'Mainnet Hydra heads require a contestation period of at least 43200 seconds',
		});
		expect(mockFindActiveHead).not.toHaveBeenCalled();
		expect(mockCreateHead).not.toHaveBeenCalled();
	});

	it('rolls back when a guarded participant claim loses a race', async () => {
		mockClaimLocalParticipant.mockResolvedValue({ count: 0 });

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 409,
			message: 'Local participant was concurrently assigned to another head',
		});
		expect(mockClaimRemoteParticipant).not.toHaveBeenCalled();
		expect(mockFindCreatedHead).not.toHaveBeenCalled();
	});

	it('translates the partial unique-index race into a conflict', async () => {
		mockTransaction.mockRejectedValue(Object.assign(new Error('unique race'), { code: 'P2002' }));

		await expect(createBoundHydraHead(input)).rejects.toMatchObject({
			statusCode: 409,
			message: 'Hydra relation or participant was concurrently assigned to another head',
		});
	});
});
