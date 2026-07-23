import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
	HydraHeadStatus,
	Network,
	OnChainState,
	PaymentSourceType,
	TransactionLayer,
	TransactionStatus,
} from '@/generated/prisma/client';

type ApplyOutcome = 'applied' | 'irrelevant' | 'retry';

const mockHydraHeadFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockHydraHeadFindFirst = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockHydraHeadFindUnique = jest.fn<() => Promise<unknown>>();
const mockHydraHeadUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockHeadLockQuery = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockPendingL2TransactionCount = jest.fn<(_args: unknown) => Promise<number>>();
const mockBlockingPaymentRequestCount = jest.fn<(_args: unknown) => Promise<number>>();
const mockBlockingPurchaseRequestCount = jest.fn<(_args: unknown) => Promise<number>>();
const mockPaymentRequestFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockPurchaseRequestFindMany = jest.fn<(_args: unknown) => Promise<unknown[]>>();
const mockPaymentRequestUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockPurchaseRequestUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockPaymentRequestUpdate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockPurchaseRequestUpdate = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockTransactionFindFirst = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockTransactionCreate = jest.fn<(_args: unknown) => Promise<{ id: string }>>();
const mockTransactionUpdate = jest.fn<(_args: unknown) => Promise<{ id: string }>>();
const mockFetchAddressUtxos = jest.fn<(_address: string) => Promise<unknown[]>>();
const mockHandleTxConfirmed = jest.fn<(..._args: unknown[]) => Promise<ApplyOutcome>>();
const mockDisconnect = jest.fn<(_hydraHeadId: string) => Promise<void>>();
const mockGetReconciliationQueue = jest.fn<() => unknown[]>();
const mockMarkReconciled = jest.fn<(_txId: string) => void>();
const mockGetConfirmedTransaction = jest.fn<(_txId: string) => unknown>();
const mockApplyDatum = jest.fn<(_args: unknown) => Promise<ApplyOutcome>>();
const mockFindLocallyRelevantIdentifiers =
	jest.fn<(_paymentSourceId: string, _identifiers: Iterable<string>) => Promise<Set<string>>>();
const mockDeserializeDatum = jest.fn<(_datumCbor: string) => unknown>();
const mockDecodeDatum = jest.fn<(_datum: unknown) => unknown>();
const mockParseEvidence = jest.fn<(_cborHex: string) => unknown>();
const mockReportExpiredL2Reservations = jest.fn<() => Promise<number>>().mockResolvedValue(0);
const mockGetVerifiedFanoutReferences = jest.fn<(_snapshotNumber: number) => unknown>();
const mockGetVerifiedFanoutReference = jest.fn<(_reference: string, _snapshotNumber: number) => unknown>();
const mockVerifyHydraFanout = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockFlushHeadStatus = jest.fn<(_hydraHeadId: string) => Promise<void>>();

const FANOUT_TX_HASH = 'f'.repeat(64);
const HEAD_IDENTIFIER = 'a'.repeat(56);
const HYDRA_OUTPUT_TX_HASH = 'b'.repeat(64);
const FANOUT_REFERENCE = {
	txHash: FANOUT_TX_HASH,
	outputIndex: 0,
	snapshotNumber: 3,
	serializedOutput: 'd87980',
};

const transactionClient = {
	$queryRaw: mockHeadLockQuery,
	hydraHead: { updateMany: mockHydraHeadUpdateMany },
	transaction: {
		count: mockPendingL2TransactionCount,
		findFirst: mockTransactionFindFirst,
		create: mockTransactionCreate,
		update: mockTransactionUpdate,
	},
	paymentRequest: {
		count: mockBlockingPaymentRequestCount,
		findMany: mockPaymentRequestFindMany,
		updateMany: mockPaymentRequestUpdateMany,
		update: mockPaymentRequestUpdate,
	},
	purchaseRequest: {
		count: mockBlockingPurchaseRequestCount,
		findMany: mockPurchaseRequestFindMany,
		updateMany: mockPurchaseRequestUpdateMany,
		update: mockPurchaseRequestUpdate,
	},
};

const mockPrismaTransaction = jest.fn<
	(callback: (tx: typeof transactionClient) => Promise<boolean>, options?: unknown) => Promise<boolean>
>(async (callback) => await callback(transactionClient));

const mockNode = {
	hasVerifiedPinnedSessions: true,
	confirmedTransactionHistoryReady: true,
	getConfirmedTransactionsForReconciliation: mockGetReconciliationQueue,
	markConfirmedTransactionReconciled: mockMarkReconciled,
	getConfirmedTransaction: mockGetConfirmedTransaction,
	getVerifiedFanoutReferences: mockGetVerifiedFanoutReferences,
	getVerifiedFanoutReference: mockGetVerifiedFanoutReference,
	status: HydraHeadStatus.Final as HydraHeadStatus,
};

const mockConnectionManager = {
	getProvider: jest.fn(() => ({ fetchAddressUTxOs: mockFetchAddressUtxos })),
	getNode: jest.fn(() => mockNode),
	handleTxConfirmed: mockHandleTxConfirmed,
	disconnect: mockDisconnect,
	// The reconciler tears down through the control-queue-serialized variant so a
	// queued reconcileEnabledState cannot immediately undo the disconnect.
	queueDisconnect: mockDisconnect,
	flushHeadStatus: mockFlushHeadStatus,
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockPrismaTransaction,
		hydraHead: {
			findMany: mockHydraHeadFindMany,
			findFirst: mockHydraHeadFindFirst,
			findUnique: mockHydraHeadFindUnique,
			updateMany: mockHydraHeadUpdateMany,
		},
		transaction: {
			count: mockPendingL2TransactionCount,
			findFirst: mockTransactionFindFirst,
			create: mockTransactionCreate,
			update: mockTransactionUpdate,
		},
		paymentRequest: {
			count: mockBlockingPaymentRequestCount,
			findMany: mockPaymentRequestFindMany,
			updateMany: mockPaymentRequestUpdateMany,
			update: mockPaymentRequestUpdate,
		},
		purchaseRequest: {
			count: mockBlockingPurchaseRequestCount,
			findMany: mockPurchaseRequestFindMany,
			updateMany: mockPurchaseRequestUpdateMany,
			update: mockPurchaseRequestUpdate,
		},
	},
}));

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { BLOCK_CONFIRMATIONS_THRESHOLD: 5 },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('@meshsdk/core', () => ({
	deserializeDatum: mockDeserializeDatum,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-connection-manager.service', () => ({
	getHydraConnectionManager: () => mockConnectionManager,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-datum-sync', () => ({
	applyDatumStateToLocalRequests: mockApplyDatum,
	findLocallyRelevantHydraRequestIdentifiers: mockFindLocallyRelevantIdentifiers,
}));

jest.unstable_mockModule('@/services/hydra-connection-manager/hydra-transaction-evidence', () => ({
	parseHydraTransactionEvidence: mockParseEvidence,
	hydraValidityUpperBoundTimeMs: jest.fn(() => null),
	observedHydraOutputMatchesEvidence: (
		evidence: {
			txHash: string;
			outputs: Array<{
				outputIndex: number;
				address: string;
				amount: Array<{ unit: string; quantity: string }>;
				plutusData: string | null;
			}>;
		},
		utxo: ReturnType<typeof liveUtxo>,
	) => {
		const output = evidence.outputs.find((candidate) => candidate.outputIndex === utxo.input.outputIndex);
		return (
			evidence.txHash === utxo.input.txHash &&
			output?.address === utxo.output.address &&
			output.plutusData === utxo.output.plutusData &&
			JSON.stringify(output.amount) === JSON.stringify(utxo.output.amount)
		);
	},
}));

jest.unstable_mockModule('@/utils/converter/string-datum-convert', () => ({
	decodeV2ContractDatum: mockDecodeDatum,
}));

jest.unstable_mockModule('@/utils/converter/network-convert', () => ({
	convertNetwork: jest.fn(() => 'preprod'),
}));

jest.unstable_mockModule('@/utils/logic/l2-datum-validation', () => ({
	smartContractStateToOnChainState: jest.fn(() => OnChainState.ResultSubmitted),
}));

jest.unstable_mockModule('./l2-reservation-recovery', () => ({
	reportExpiredL2Reservations: mockReportExpiredL2Reservations,
}));

jest.unstable_mockModule('@/utils/blockfrost', () => ({
	getBlockfrostInstance: jest.fn(() => ({ observer: true })),
}));

jest.unstable_mockModule('@/lib/hydra/hydra/fanout-validation', () => ({
	verifyHydraFanoutOnChain: mockVerifyHydraFanout,
}));

const { reconcileHydraHeadEscrowStates } = await import('./index');

function liveUtxo(txHash: string) {
	return {
		input: { txHash, outputIndex: 0 },
		output: {
			address: 'addr_test1_contract',
			amount: [{ unit: 'lovelace', quantity: '10000000' }],
			plutusData: txHash,
		},
	};
}

function evidenceFor(txHash: string) {
	return {
		txHash,
		inputs: [],
		spends: [],
		signerVkeys: [],
		outputs: [
			{
				outputIndex: 0,
				address: 'addr_test1_contract',
				amount: [{ unit: 'lovelace', quantity: '10000000' }],
				plutusData: txHash,
			},
		],
	};
}

function activeHandoffCandidate(id: string) {
	return {
		id,
		layer: TransactionLayer.L2,
		currentTransactionId: `${id}-l2-transaction`,
		onChainState: OnChainState.ResultSubmitted,
		currentHydraUtxoTxHash: HYDRA_OUTPUT_TX_HASH,
		currentHydraUtxoOutputIndex: 0,
		currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '10000000' }],
		unresolvedHydraTerminalTxHash: null,
		unresolvedHydraTerminalReason: null,
		hydraFanoutHandoffHeadId: null,
		hydraFanoutHandoffTxHash: null,
		hydraFanoutHandoffOutputIndex: null,
		CurrentTransaction: {
			status: TransactionStatus.Confirmed,
			txHash: HYDRA_OUTPUT_TX_HASH,
			layer: TransactionLayer.L2,
			hydraHeadId: 'head-1',
			newOnChainState: OnChainState.ResultSubmitted,
		},
	};
}

function settledTerminalCandidate(id: string, onChainState: OnChainState) {
	return {
		...activeHandoffCandidate(id),
		onChainState,
		currentHydraUtxoTxHash: null,
		currentHydraUtxoOutputIndex: null,
		currentHydraUtxoValue: null,
		CurrentTransaction: {
			...activeHandoffCandidate(id).CurrentTransaction,
			newOnChainState: onChainState,
		},
	};
}

describe('Hydra live-snapshot reconciliation', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockNode.hasVerifiedPinnedSessions = true;
		mockNode.confirmedTransactionHistoryReady = true;
		mockNode.status = HydraHeadStatus.Final;
		mockHydraHeadFindMany.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				headIdentifier: HEAD_IDENTIFIER,
				latestSnapshotNumber: 3n,
				finalizedAt: new Date('2026-07-22T12:00:00Z'),
				reconciliationCompletedAt: null,
				HydraRelation: {
					LocalHotWallet: {
						walletVkey: '1'.repeat(56),
						PaymentSource: {
							id: 'source-1',
							network: Network.Preprod,
							smartContractAddress: 'addr_test1_contract',
							paymentSourceType: PaymentSourceType.Web3CardanoV2,
							PaymentSourceConfig: { rpcProviderApiKey: 'provider-key' },
						},
					},
					RemoteWallet: { walletVkey: '2'.repeat(56) },
				},
			},
		]);
		mockHydraHeadFindFirst.mockResolvedValue({ id: 'head-1' });
		mockGetReconciliationQueue.mockReturnValue([]);
		mockHydraHeadFindUnique.mockResolvedValue(null);
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 1 });
		mockHeadLockQuery.mockImplementation(async () =>
			mockHeadLockQuery.mock.calls.length % 2 === 1
				? [{ id: 'relation-1' }]
				: [
						{
							status: HydraHeadStatus.Final,
							isEnabled: true,
							initTxHash: 'c'.repeat(64),
							finalizedAt: new Date('2026-07-22T12:00:00Z'),
							reconciliationCompletedAt: null,
							headIdentifier: HEAD_IDENTIFIER,
							latestSnapshotNumber: 3n,
							fanoutTxHash: null,
						},
					],
		);
		mockPendingL2TransactionCount.mockResolvedValue(0);
		mockBlockingPaymentRequestCount.mockResolvedValue(0);
		mockBlockingPurchaseRequestCount.mockResolvedValue(0);
		mockPaymentRequestFindMany.mockResolvedValue([]);
		mockPurchaseRequestFindMany.mockResolvedValue([]);
		mockPaymentRequestUpdateMany.mockResolvedValue({ count: 1 });
		mockPurchaseRequestUpdateMany.mockResolvedValue({ count: 1 });
		mockPaymentRequestUpdate.mockResolvedValue({});
		mockPurchaseRequestUpdate.mockResolvedValue({});
		mockTransactionFindFirst.mockResolvedValue(null);
		mockTransactionCreate.mockResolvedValue({ id: 'fanout-transaction' });
		mockTransactionUpdate.mockResolvedValue({ id: 'fanout-transaction' });
		mockGetVerifiedFanoutReferences.mockReturnValue([FANOUT_REFERENCE]);
		mockGetVerifiedFanoutReference.mockReturnValue(FANOUT_REFERENCE);
		mockVerifyHydraFanout.mockResolvedValue({
			txHash: FANOUT_TX_HASH,
			confirmations: 8,
			fees: 200000n,
			blockHeight: 123,
			blockTime: 456,
			outputAmount: '[]',
			utxoCount: 1,
			withdrawalCount: 0,
			assetMintOrBurnCount: 3,
			redeemerCount: 1,
			validContract: true,
		});
		mockFlushHeadStatus.mockResolvedValue();
		mockFetchAddressUtxos.mockResolvedValue([]);
		mockGetConfirmedTransaction.mockImplementation((txHash) => ({
			txId: txHash,
			cborHex: txHash,
			confirmedAtMs: 1,
		}));
		mockParseEvidence.mockImplementation((cborHex) => evidenceFor(cborHex));
		mockDeserializeDatum.mockImplementation((datumCbor) => datumCbor);
		mockDecodeDatum.mockImplementation((datum) => ({
			blockchainIdentifier: String(datum),
			state: 'result-submitted',
		}));
		mockHandleTxConfirmed.mockResolvedValue('applied');
		mockDisconnect.mockResolvedValue();
		mockFindLocallyRelevantIdentifiers.mockImplementation(
			async (_paymentSourceId, identifiers) => new Set(identifiers),
		);
	});

	it('selects and revalidates only enabled heads with durable init evidence', async () => {
		await reconcileHydraHeadEscrowStates();

		expect(mockHydraHeadFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { isEnabled: true, initTxHash: { not: null } } }),
		);
		expect(mockHydraHeadFindFirst).toHaveBeenCalledWith({
			where: { id: 'head-1', isEnabled: true, initTxHash: { not: null } },
			select: { id: true },
		});
	});

	it('does not replay or inspect a stale candidate that fails durable eligibility revalidation', async () => {
		mockHydraHeadFindFirst.mockResolvedValue(null);
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-history',
				cborHex: 'tx-history',
				confirmedAtMs: null,
				snapshotSequence: 1,
				snapshotTransactionIndex: 0,
			},
		]);

		await reconcileHydraHeadEscrowStates();

		expect(mockHandleTxConfirmed).not.toHaveBeenCalled();
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(mockMarkReconciled).not.toHaveBeenCalled();
		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
	});

	it('accumulates live outcomes and keeps a finalized head connected when any output needs retry', async () => {
		mockFetchAddressUtxos.mockResolvedValue([liveUtxo('tx-retry'), liveUtxo('tx-applied')]);
		mockApplyDatum.mockResolvedValueOnce('retry').mockResolvedValueOnce('applied');

		await reconcileHydraHeadEscrowStates();

		expect(mockApplyDatum).toHaveBeenCalledTimes(2);
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('disconnects a finalized head after all live observations and replay work are resolved', async () => {
		mockFetchAddressUtxos.mockResolvedValue([liveUtxo('tx-applied'), liveUtxo('tx-irrelevant')]);
		mockApplyDatum.mockResolvedValueOnce('applied').mockResolvedValueOnce('irrelevant');

		await reconcileHydraHeadEscrowStates();

		expect(mockApplyDatum).toHaveBeenCalledTimes(2);
		expect(mockApplyDatum).toHaveBeenCalledWith(expect.objectContaining({ network: Network.Preprod }));
		expect(mockHeadLockQuery).toHaveBeenCalledTimes(2);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'head-1',
				status: HydraHeadStatus.Final,
				isEnabled: true,
				initTxHash: { not: null },
				finalizedAt: { not: null },
				reconciliationCompletedAt: null,
				headIdentifier: HEAD_IDENTIFIER,
				latestSnapshotNumber: 3n,
				OR: [{ fanoutTxHash: null }, { fanoutTxHash: FANOUT_TX_HASH }],
			},
			data: {
				fanoutTxHash: FANOUT_TX_HASH,
				reconciliationCompletedAt: expect.any(Date),
			},
		});
		expect(mockHeadLockQuery.mock.invocationCallOrder[0]).toBeLessThan(
			mockPendingL2TransactionCount.mock.invocationCallOrder[0],
		);
		expect(mockPurchaseRequestFindMany.mock.invocationCallOrder[1]).toBeLessThan(
			mockHydraHeadUpdateMany.mock.invocationCallOrder[0],
		);
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
	});

	it.each(['payment', 'purchase'] as const)(
		'atomically adopts a surviving %s fanout output into direct L1 ownership',
		async (kind) => {
			const candidate = activeHandoffCandidate(`${kind}-live`);
			if (kind === 'payment') mockPaymentRequestFindMany.mockResolvedValue([candidate]);
			else mockPurchaseRequestFindMany.mockResolvedValue([candidate]);

			await reconcileHydraHeadEscrowStates();

			expect(mockVerifyHydraFanout).toHaveBeenCalledWith(
				expect.objectContaining({
					headId: HEAD_IDENTIFIER,
					references: [FANOUT_REFERENCE],
					requiredConfirmations: 5,
				}),
			);
			expect(mockTransactionCreate).toHaveBeenCalledWith({
				data: expect.objectContaining({
					txHash: FANOUT_TX_HASH,
					status: TransactionStatus.Confirmed,
					layer: TransactionLayer.L1,
					hydraHeadId: 'head-1',
				}),
				select: { id: true },
			});
			const update = kind === 'payment' ? mockPaymentRequestUpdate : mockPurchaseRequestUpdate;
			expect(update).toHaveBeenCalledWith({
				where: { id: candidate.id },
				data: expect.objectContaining({
					layer: TransactionLayer.L1,
					currentHydraUtxoTxHash: null,
					currentHydraUtxoOutputIndex: null,
					hydraFanoutHandoffHeadId: null,
					hydraFanoutHandoffTxHash: null,
					hydraFanoutHandoffOutputIndex: null,
					TransactionHistory: { connect: { id: candidate.currentTransactionId } },
					CurrentTransaction: { connect: { id: 'fanout-transaction' } },
				}),
			});
			const adoptionData = jest.mocked(update).mock.calls[0][0] as { data: Record<string, unknown> };
			expect(adoptionData.data).not.toHaveProperty('forceLayer');
			expect(adoptionData.data).not.toHaveProperty('paymentForceLayer');
			expect(mockDisconnect).toHaveBeenCalledWith('head-1');
		},
	);

	it.each([
		['rolled-back lineage', { CurrentTransaction: { status: TransactionStatus.RolledBack } }],
		['mismatched producer', { CurrentTransaction: { txHash: '9'.repeat(64) } }],
		['request layer drift', { layer: TransactionLayer.L1 }],
	] as const)('blocks fanout adoption for %s', async (_label, mutation) => {
		const candidate = activeHandoffCandidate('malformed');
		Object.assign(candidate, mutation);
		if ('CurrentTransaction' in mutation) {
			Object.assign(candidate.CurrentTransaction, mutation.CurrentTransaction);
		}
		mockPaymentRequestFindMany.mockResolvedValue([candidate]);

		await reconcileHydraHeadEscrowStates();

		expect(mockVerifyHydraFanout).not.toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it.each([
		['payment', OnChainState.Withdrawn],
		['purchase', OnChainState.RefundWithdrawn],
	] as const)('moves an authenticated settled %s terminal lineage to history', async (kind, state) => {
		const terminal = settledTerminalCandidate(`${kind}-terminal`, state);
		if (kind === 'payment') mockPaymentRequestFindMany.mockResolvedValue([terminal]);
		else mockPurchaseRequestFindMany.mockResolvedValue([terminal]);

		await reconcileHydraHeadEscrowStates();

		const update = kind === 'payment' ? mockPaymentRequestUpdate : mockPurchaseRequestUpdate;
		expect(update).toHaveBeenCalledWith({
			where: { id: terminal.id },
			data: {
				TransactionHistory: { connect: { id: terminal.currentTransactionId } },
				CurrentTransaction: { disconnect: true },
			},
		});
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
	});

	it.each([OnChainState.DisputedWithdrawn, OnChainState.ResultSubmitted])(
		'does not exempt an all-null %s row',
		async (state) => {
			mockPaymentRequestFindMany.mockResolvedValue([settledTerminalCandidate('unsafe-null-row', state)]);
			await reconcileHydraHeadEscrowStates();
			expect(mockVerifyHydraFanout).not.toHaveBeenCalled();
			expect(mockDisconnect).not.toHaveBeenCalled();
		},
	);

	it('aborts after L1 proof when the in-memory Final fanout evidence disappears under the head lock', async () => {
		mockGetVerifiedFanoutReferences.mockReturnValueOnce([FANOUT_REFERENCE]).mockReturnValueOnce(null);

		await reconcileHydraHeadEscrowStates();

		expect(mockVerifyHydraFanout).toHaveBeenCalled();
		expect(mockTransactionCreate).not.toHaveBeenCalled();
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('keeps a finalized head connected while a head-scoped L2 transaction is still pending', async () => {
		mockFetchAddressUtxos.mockResolvedValue([]);
		mockPendingL2TransactionCount.mockResolvedValue(1);

		await reconcileHydraHeadEscrowStates();

		expect(mockPendingL2TransactionCount).toHaveBeenCalledWith({
			where: {
				hydraHeadId: 'head-1',
				layer: 'L2',
				status: 'Pending',
			},
		});
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it.each([['payment'], ['purchase']] as const)(
		'keeps a finalized head connected while a head-owned L2 %s request has unresolved evidence',
		async (requestKind) => {
			const unresolved = {
				id: `${requestKind}-1`,
				layer: TransactionLayer.L2,
				currentTransactionId: 'l2-tx',
				onChainState: OnChainState.Disputed,
				currentHydraUtxoTxHash: HYDRA_OUTPUT_TX_HASH,
				currentHydraUtxoOutputIndex: 0,
				currentHydraUtxoValue: [{ unit: 'lovelace', quantity: '1' }],
				unresolvedHydraTerminalTxHash: 'c'.repeat(64),
				unresolvedHydraTerminalReason: 'unverified',
				hydraFanoutHandoffHeadId: null,
				hydraFanoutHandoffTxHash: null,
				hydraFanoutHandoffOutputIndex: null,
				CurrentTransaction: {
					status: TransactionStatus.Confirmed,
					txHash: HYDRA_OUTPUT_TX_HASH,
					layer: TransactionLayer.L2,
					hydraHeadId: 'head-1',
				},
			};
			if (requestKind === 'payment') mockPaymentRequestFindMany.mockResolvedValue([unresolved]);
			else mockPurchaseRequestFindMany.mockResolvedValue([unresolved]);

			await reconcileHydraHeadEscrowStates();

			expect(requestKind === 'payment' ? mockPaymentRequestFindMany : mockPurchaseRequestFindMany).toHaveBeenCalled();
			expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
			expect(mockDisconnect).not.toHaveBeenCalled();
		},
	);

	it('does not disconnect when the Final/enabled completion-marker CAS loses its race', async () => {
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 0 });

		await reconcileHydraHeadEscrowStates();

		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('retries transport teardown without replay when reconciliation was already durably completed', async () => {
		mockHydraHeadFindMany.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				headIdentifier: HEAD_IDENTIFIER,
				latestSnapshotNumber: 3n,
				finalizedAt: new Date('2026-07-22T12:00:00Z'),
				reconciliationCompletedAt: new Date('2026-07-22T12:01:00Z'),
				HydraRelation: {
					LocalHotWallet: {
						walletVkey: '1'.repeat(56),
						PaymentSource: {
							id: 'source-1',
							network: Network.Preprod,
							smartContractAddress: 'addr_test1_contract',
							paymentSourceType: PaymentSourceType.Web3CardanoV2,
							PaymentSourceConfig: { rpcProviderApiKey: 'provider-key' },
						},
					},
					RemoteWallet: { walletVkey: '2'.repeat(56) },
				},
			},
		]);

		await reconcileHydraHeadEscrowStates();

		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
		expect(mockPendingL2TransactionCount).not.toHaveBeenCalled();
		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
	});

	it('does not disconnect a stale completed candidate after the live node regresses before status flush', async () => {
		mockHydraHeadFindMany.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				headIdentifier: HEAD_IDENTIFIER,
				latestSnapshotNumber: 3n,
				finalizedAt: new Date('2026-07-22T12:00:00Z'),
				reconciliationCompletedAt: new Date('2026-07-22T12:01:00Z'),
				HydraRelation: {
					LocalHotWallet: {
						walletVkey: '1'.repeat(56),
						PaymentSource: {
							id: 'source-1',
							network: Network.Preprod,
							smartContractAddress: 'addr_test1_contract',
							paymentSourceType: PaymentSourceType.Web3CardanoV2,
							PaymentSourceConfig: { rpcProviderApiKey: 'provider-key' },
						},
					},
					RemoteWallet: { walletVkey: '2'.repeat(56) },
				},
			},
		]);
		mockFlushHeadStatus.mockImplementation(async () => {
			mockNode.status = HydraHeadStatus.Open;
		});

		await reconcileHydraHeadEscrowStates();

		expect(mockFlushHeadStatus).toHaveBeenCalledWith('head-1');
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('returns before the live snapshot when ordered replay needs retry', async () => {
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-history',
				cborHex: 'tx-history',
				confirmedAtMs: null,
				snapshotSequence: 1,
				snapshotTransactionIndex: 0,
			},
		]);
		mockHandleTxConfirmed.mockResolvedValue('retry');

		await reconcileHydraHeadEscrowStates();

		expect(mockReportExpiredL2Reservations).not.toHaveBeenCalled();
		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
		expect(mockMarkReconciled).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it.each([
		['session identity is not pinned', false, true],
		['history replay is incomplete', true, false],
	])('does not inspect the live tip when %s', async (_description, hasPinnedSessions, isHistoryReady) => {
		mockNode.hasVerifiedPinnedSessions = hasPinnedSessions;
		mockNode.confirmedTransactionHistoryReady = isHistoryReady;
		mockFetchAddressUtxos.mockResolvedValue([liveUtxo('tx-live')]);

		await reconcileHydraHeadEscrowStates();

		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
		expect(mockApplyDatum).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('persists the ordered replay cursor before removing evidence from memory', async () => {
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-history',
				cborHex: 'tx-history',
				confirmedAtMs: null,
				snapshotSequence: 7,
				snapshotTransactionIndex: 3,
			},
		]);
		mockFetchAddressUtxos.mockResolvedValue([]);

		await reconcileHydraHeadEscrowStates();

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: 'head-1',
				isEnabled: true,
				initTxHash: { not: null },
			}),
			data: {
				lastReconciledSnapshotSequence: 7n,
				lastReconciledSnapshotTransactionIndex: 3,
			},
		});
		expect(mockMarkReconciled).toHaveBeenCalledWith('tx-history');
		expect(mockHydraHeadUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
			mockMarkReconciled.mock.invocationCallOrder[0],
		);
	});

	it('keeps replay evidence queued when it lacks a durable sequence cursor', async () => {
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-history',
				cborHex: 'tx-history',
				confirmedAtMs: null,
				snapshotSequence: null,
				snapshotTransactionIndex: 0,
			},
		]);

		await reconcileHydraHeadEscrowStates();

		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(mockMarkReconciled).not.toHaveBeenCalled();
		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
	});

	it('keeps unsupported confirmed transaction evidence queued without advancing the cursor', async () => {
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-unsupported',
				cborHex: 'tx-unsupported',
				confirmedAtMs: null,
				snapshotSequence: 2,
				snapshotTransactionIndex: 0,
			},
		]);
		mockParseEvidence.mockReturnValue(null);

		await reconcileHydraHeadEscrowStates();

		expect(mockHandleTxConfirmed).not.toHaveBeenCalled();
		// The pause is surfaced to operators as a persisted stall marker — the ONLY
		// HydraHead write this pass may make (the cursor must not advance).
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					reconciliationStalledTxId: 'tx-unsupported',
					reconciliationStalledReason: 'evidence-parse-failed',
				}),
			}),
		);
		expect(mockMarkReconciled).not.toHaveBeenCalled();
		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
	});

	it('retains replay evidence when the head disappears before cursor persistence', async () => {
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-history',
				cborHex: 'tx-history',
				confirmedAtMs: null,
				snapshotSequence: 2,
				snapshotTransactionIndex: 0,
			},
		]);
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 0 });
		mockHydraHeadFindUnique.mockResolvedValue(null);

		await reconcileHydraHeadEscrowStates();

		expect(mockHydraHeadFindUnique).toHaveBeenCalled();
		expect(mockMarkReconciled).not.toHaveBeenCalled();
		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
	});

	it.each([
		['disabled', { isEnabled: false, initTxHash: 'c'.repeat(64) }],
		['missing init evidence', { isEnabled: true, initTxHash: null }],
	] as const)('retains replay evidence when the head becomes %s during cursor persistence', async (_label, head) => {
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-history',
				cborHex: 'tx-history',
				confirmedAtMs: null,
				snapshotSequence: 2,
				snapshotTransactionIndex: 0,
			},
		]);
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 0 });
		mockHydraHeadFindUnique.mockResolvedValue({
			...head,
			lastReconciledSnapshotSequence: 3n,
			lastReconciledSnapshotTransactionIndex: 0,
		});

		await reconcileHydraHeadEscrowStates();

		expect(mockMarkReconciled).not.toHaveBeenCalled();
		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
	});

	it('accepts a cursor already advanced by a concurrent worker', async () => {
		mockGetReconciliationQueue.mockReturnValue([
			{
				txId: 'tx-history',
				cborHex: 'tx-history',
				confirmedAtMs: null,
				snapshotSequence: 2,
				snapshotTransactionIndex: 0,
			},
		]);
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 0 });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			initTxHash: 'c'.repeat(64),
			lastReconciledSnapshotSequence: 3n,
			lastReconciledSnapshotTransactionIndex: 0,
		});
		mockFetchAddressUtxos.mockResolvedValue([]);

		await reconcileHydraHeadEscrowStates();

		expect(mockMarkReconciled).toHaveBeenCalledWith('tx-history');
	});

	it('rejects an altered live output that reuses a confirmed transaction reference', async () => {
		const altered = liveUtxo('tx-original');
		altered.output.plutusData = 'attacker-modified-datum';
		mockFetchAddressUtxos.mockResolvedValue([altered]);

		await reconcileHydraHeadEscrowStates();

		expect(mockApplyDatum).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('keeps a finalized head connected while duplicate live identifiers remain ambiguous', async () => {
		mockFetchAddressUtxos.mockResolvedValue([liveUtxo('tx-first'), liveUtxo('tx-second')]);
		mockDecodeDatum.mockReturnValue({
			blockchainIdentifier: 'duplicate-identifier',
			state: 'result-submitted',
		});

		await reconcileHydraHeadEscrowStates();

		expect(mockApplyDatum).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});

	it('ignores duplicate live identifiers that have no local request', async () => {
		mockFetchAddressUtxos.mockResolvedValue([liveUtxo('tx-first'), liveUtxo('tx-second')]);
		mockDecodeDatum.mockReturnValue({
			blockchainIdentifier: 'external-duplicate',
			state: 'result-submitted',
		});
		mockFindLocallyRelevantIdentifiers.mockResolvedValue(new Set());

		await reconcileHydraHeadEscrowStates();

		expect(mockFindLocallyRelevantIdentifiers).toHaveBeenCalledWith('source-1', ['external-duplicate']);
		expect(mockApplyDatum).not.toHaveBeenCalled();
		expect(mockDisconnect).toHaveBeenCalledWith('head-1');
	});

	it('bounds ordered replay and defers the live tip while a causal suffix remains', async () => {
		mockGetReconciliationQueue.mockReturnValue(
			Array.from({ length: 251 }, (_, index) => ({
				txId: `tx-history-${index}`,
				cborHex: `tx-history-${index}`,
				confirmedAtMs: null,
				snapshotSequence: index,
				snapshotTransactionIndex: 0,
			})),
		);

		await reconcileHydraHeadEscrowStates();

		expect(mockHandleTxConfirmed).toHaveBeenCalledTimes(250);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledTimes(250);
		expect(mockMarkReconciled).toHaveBeenCalledTimes(250);
		expect(mockFetchAddressUtxos).not.toHaveBeenCalled();
		expect(mockDisconnect).not.toHaveBeenCalled();
	});
});
