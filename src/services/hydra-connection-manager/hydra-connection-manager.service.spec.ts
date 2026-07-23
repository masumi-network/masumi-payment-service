import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { HydraHeadStatus, Network, OnChainState, TransactionStatus } from '@/generated/prisma/client';
import { SmartContractState } from '@masumi/payment-core/smart-contract-state';
import {
	CustomHydraHead,
	deriveHydraVerificationKeyCborHex,
	HydraNode,
	HydraTransactionType,
	type HydraConfirmedTransaction,
} from '@/lib/hydra';
import { EventEmitter } from 'node:events';
import { encrypt } from '@/utils/security/encryption';

const mockTransactionFindFirst = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockTransactionFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockHydraHeadFindUnique = jest.fn<(_args: unknown) => Promise<unknown>>();
const mockHydraHeadUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockPrismaTransaction = jest.fn<(...args: any[]) => Promise<unknown>>();
const mockQueryRaw = jest.fn<(...args: any[]) => Promise<unknown[]>>();
const mockPaymentRequestUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockPurchaseRequestUpdateMany = jest.fn<(_args: unknown) => Promise<{ count: number }>>();
const mockApplyDatum = jest.fn<(_args: unknown) => Promise<'applied' | 'irrelevant' | 'retry'>>();
const mockApplyTerminal = jest.fn<(_args: unknown) => Promise<'applied' | 'irrelevant' | 'retry'>>();
const mockFindLocallyRelevantIdentifiers =
	jest.fn<(_paymentSourceId: string, _identifiers: Iterable<string>) => Promise<Set<string>>>();
const mockParseEvidence = jest.fn<(cborHex: string) => unknown>();
const mockFetchUtxos = jest.fn<(_txId?: string) => Promise<unknown[]>>();
const mockDecodeV2ContractDatum = jest.fn<(...args: unknown[]) => unknown>();

const transactionClient = {
	$queryRaw: mockQueryRaw,
	hydraHead: { updateMany: mockHydraHeadUpdateMany },
	paymentRequest: { updateMany: mockPaymentRequestUpdateMany },
	purchaseRequest: { updateMany: mockPurchaseRequestUpdateMany },
};

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: {
		$transaction: mockPrismaTransaction,
		transaction: { findFirst: mockTransactionFindFirst, findUnique: mockTransactionFindUnique },
		hydraHead: { findUnique: mockHydraHeadFindUnique, updateMany: mockHydraHeadUpdateMany },
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.unstable_mockModule('./hydra-datum-sync', () => ({
	applyDatumStateToLocalRequests: mockApplyDatum,
	applyTerminalHydraSpends: mockApplyTerminal,
	findLocallyRelevantHydraRequestIdentifiers: mockFindLocallyRelevantIdentifiers,
}));

jest.unstable_mockModule('./hydra-transaction-evidence', () => ({
	parseHydraTransactionEvidence: mockParseEvidence,
}));

jest.unstable_mockModule('@/utils/converter/string-datum-convert', () => ({
	decodeV2ContractDatum: mockDecodeV2ContractDatum,
}));

const { HydraConnectionManager } = await import('./hydra-connection-manager.service');

function confirmedTransaction(txId: string): HydraConfirmedTransaction {
	return {
		type: HydraTransactionType.TxConwayEra,
		cborHex: txId,
		description: '',
		txId,
		confirmedAtMs: Date.parse('2026-07-22T10:00:00Z'),
		snapshotSequence: txId === 't1' ? 1 : 2,
		snapshotTransactionIndex: 0,
	};
}

function connectableConfiguredHead(id = 'head-1') {
	const localSigningKey = `5820${'11'.repeat(32)}`;
	const remoteSigningKey = `5820${'22'.repeat(32)}`;
	return {
		id,
		isEnabled: true,
		status: HydraHeadStatus.Idle,
		initTxHash: null,
		headIdentifier: null,
		lastReconciledSnapshotSequence: null,
		lastReconciledSnapshotTransactionIndex: null,
		LocalParticipant: {
			walletId: 'local-wallet',
			nodeHttpUrl: 'http://127.0.0.1:4001',
			nodeUrl: 'ws://127.0.0.1:4001',
			HydraSecretKey: { hydraSK: encrypt(localSigningKey) },
		},
		RemoteParticipants: [
			{
				walletId: 'remote-wallet',
				HydraVerificationKey: { hydraVK: deriveHydraVerificationKeyCborHex(remoteSigningKey) },
			},
		],
		HydraRelation: {
			network: Network.Preprod,
			localHotWalletId: 'local-wallet',
			remoteWalletId: 'remote-wallet',
			LocalHotWallet: {
				deletedAt: null,
				PaymentSource: { network: Network.Preprod, deletedAt: null, disableSyncAt: null },
			},
			RemoteWallet: {
				PaymentSource: { network: Network.Preprod, deletedAt: null, disableSyncAt: null },
			},
		},
	};
}

describe('HydraConnectionManager confirmed transaction output sync', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockPrismaTransaction.mockImplementation(
			async (operation: (tx: unknown) => Promise<unknown>) => await operation(transactionClient),
		);
		mockPaymentRequestUpdateMany.mockResolvedValue({ count: 0 });
		mockPurchaseRequestUpdateMany.mockResolvedValue({ count: 0 });
		mockTransactionFindFirst.mockResolvedValue(null);
		mockTransactionFindUnique.mockResolvedValue(null);
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			initTxHash: 'a'.repeat(64),
			status: HydraHeadStatus.Idle,
			headIdentifier: null,
			openedAt: null,
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 0n,
			HydraRelation: {
				LocalHotWallet: {
					PaymentSource: {
						id: 'source-1',
						network: Network.Preprod,
						smartContractAddress: 'addr_test1_contract',
					},
				},
			},
		});
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 1 });
		mockFetchUtxos.mockResolvedValue([]);
		mockApplyDatum.mockResolvedValue('applied');
		mockApplyTerminal.mockResolvedValue('irrelevant');
		mockFindLocallyRelevantIdentifiers.mockImplementation(
			async (_paymentSourceId, identifiers) => new Set(identifiers),
		);
		mockDecodeV2ContractDatum.mockReturnValue({
			blockchainIdentifier: 'blockchain-1',
			state: SmartContractState.ResultSubmitted,
		});
		mockParseEvidence.mockImplementation((txId) => ({
			txHash: txId,
			inputs: [],
			spends: [],
			signerVkeys: [],
			outputs: [
				{
					outputIndex: txId === 't1' ? 1 : 2,
					address: 'addr_test1_contract',
					amount: [{ unit: 'lovelace', quantity: '10000000' }],
					plutusData: 'd87980',
				},
			],
		}));
	});

	it('fails closed before transport startup when a legacy head has no remote verification key', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue({
			id: 'legacy-head',
			isEnabled: true,
			status: HydraHeadStatus.Idle,
			initTxHash: null,
			LocalParticipant: {
				walletId: 'wallet-1',
				nodeHttpUrl: 'http://127.0.0.1:4001',
				nodeUrl: 'ws://127.0.0.1:4001',
				HydraSecretKey: { hydraSK: 'not-reached' },
			},
			RemoteParticipants: [],
		});

		await expect(manager.connect({ id: 'legacy-head' })).rejects.toThrow(/exactly one configured remote participant/);
	});

	it('fails closed when participant wallets do not match the head relation', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue({
			id: 'corrupt-head',
			isEnabled: true,
			status: HydraHeadStatus.Idle,
			initTxHash: null,
			LocalParticipant: {
				walletId: 'wrong-local-wallet',
				nodeHttpUrl: 'http://127.0.0.1:4001',
				nodeUrl: 'ws://127.0.0.1:4001',
				HydraSecretKey: { hydraSK: 'not-reached' },
			},
			RemoteParticipants: [{ walletId: 'remote-wallet', HydraVerificationKey: { hydraVK: 'not-reached' } }],
			HydraRelation: { localHotWalletId: 'local-wallet', remoteWalletId: 'remote-wallet' },
		});

		await expect(manager.connect({ id: 'corrupt-head' })).rejects.toThrow(/did not match the wallets/);
	});

	it('fails closed when relation participants belong to different networks', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue({
			id: 'cross-network-head',
			isEnabled: true,
			status: HydraHeadStatus.Idle,
			initTxHash: null,
			LocalParticipant: {
				walletId: 'local-wallet',
				nodeHttpUrl: 'http://127.0.0.1:4001',
				nodeUrl: 'ws://127.0.0.1:4001',
				HydraSecretKey: { hydraSK: 'not-reached' },
			},
			RemoteParticipants: [{ walletId: 'remote-wallet', HydraVerificationKey: { hydraVK: 'not-reached' } }],
			HydraRelation: {
				network: Network.Preprod,
				localHotWalletId: 'local-wallet',
				remoteWalletId: 'remote-wallet',
				LocalHotWallet: {
					deletedAt: null,
					PaymentSource: { network: Network.Preprod, deletedAt: null, disableSyncAt: null },
				},
				RemoteWallet: {
					PaymentSource: { network: Network.Mainnet, deletedAt: null, disableSyncAt: null },
				},
			},
		});

		await expect(manager.connect({ id: 'cross-network-head' })).rejects.toThrow(/same network/);
	});

	it('fails closed when a relation payment source has sync disabled', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue({
			id: 'disabled-source-head',
			isEnabled: true,
			status: HydraHeadStatus.Idle,
			initTxHash: null,
			LocalParticipant: {
				walletId: 'local-wallet',
				nodeHttpUrl: 'http://127.0.0.1:4001',
				nodeUrl: 'ws://127.0.0.1:4001',
				HydraSecretKey: { hydraSK: 'not-reached' },
			},
			RemoteParticipants: [{ walletId: 'remote-wallet', HydraVerificationKey: { hydraVK: 'not-reached' } }],
			HydraRelation: {
				network: Network.Preprod,
				localHotWalletId: 'local-wallet',
				remoteWalletId: 'remote-wallet',
				LocalHotWallet: {
					deletedAt: null,
					PaymentSource: { network: Network.Preprod, deletedAt: null, disableSyncAt: new Date() },
				},
				RemoteWallet: {
					PaymentSource: { network: Network.Preprod, deletedAt: null, disableSyncAt: null },
				},
			},
		});

		await expect(manager.connect({ id: 'disabled-source-head' })).rejects.toThrow(/active, sync-enabled/);
	});

	it('fails closed before loading keys or starting transport when the head is disabled', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue({
			id: 'disabled-head',
			isEnabled: false,
			status: HydraHeadStatus.Idle,
			initTxHash: null,
		});

		await expect(manager.connect({ id: 'disabled-head' })).rejects.toThrow(/head disabled-head is disabled/);
	});

	it('shares one in-flight transport startup across concurrent connect callers', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue(connectableConfiguredHead());
		let releaseProbe!: (isReachable: boolean) => void;
		let markProbeStarted!: () => void;
		const probeStarted = new Promise<void>((resolve) => {
			markProbeStarted = resolve;
		});
		const probeResult = new Promise<boolean>((resolve) => {
			releaseProbe = resolve;
		});
		const probeSpy = jest
			.spyOn(
				manager as unknown as { probeNode: (httpUrl: string, timeoutMs?: number) => Promise<boolean> },
				'probeNode',
			)
			.mockImplementation(async () => {
				markProbeStarted();
				return await probeResult;
			});
		const connectSpy = jest.spyOn(CustomHydraHead.prototype, 'connect').mockImplementation(async () => undefined);

		try {
			const firstConnect = manager.connect({ id: 'head-1' });
			await probeStarted;
			const secondConnect = manager.connect({ id: 'head-1' });

			expect(mockHydraHeadFindUnique).toHaveBeenCalledTimes(1);
			releaseProbe(true);
			await Promise.all([firstConnect, secondConnect]);
			expect(connectSpy).toHaveBeenCalledTimes(1);
			expect(manager.isConnected('head-1')).toBe(true);
		} finally {
			probeSpy.mockRestore();
			connectSpy.mockRestore();
		}
	});

	it('does not publish a transport revoked while its reachability probe is pending', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue(connectableConfiguredHead());
		let releaseProbe!: (isReachable: boolean) => void;
		let markProbeStarted!: () => void;
		const probeStarted = new Promise<void>((resolve) => {
			markProbeStarted = resolve;
		});
		const probeResult = new Promise<boolean>((resolve) => {
			releaseProbe = resolve;
		});
		const probeSpy = jest
			.spyOn(
				manager as unknown as { probeNode: (httpUrl: string, timeoutMs?: number) => Promise<boolean> },
				'probeNode',
			)
			.mockImplementation(async () => {
				markProbeStarted();
				return await probeResult;
			});
		const connectSpy = jest.spyOn(CustomHydraHead.prototype, 'connect').mockImplementation(async () => undefined);

		try {
			const pendingConnect = manager.connect({ id: 'head-1' });
			await probeStarted;
			await manager.disconnect('head-1');
			releaseProbe(true);

			await expect(pendingConnect).rejects.toThrow('transport was revoked while connecting');
			expect(connectSpy).not.toHaveBeenCalled();
			expect(manager.isConnected('head-1')).toBe(false);
		} finally {
			probeSpy.mockRestore();
			connectSpy.mockRestore();
		}
	});

	it.each([
		['disabled', { isEnabled: false, initTxHash: 'a'.repeat(64) }],
		['not independently verified', { isEnabled: true, initTxHash: null }],
	])('does not apply confirmed L2 evidence when the durable head is %s', async (_reason, durableHead) => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue(durableHead);

		await expect(manager.handleTxConfirmed('head-1', 't1', confirmedTransaction('t1'))).resolves.toBe('retry');

		expect(mockParseEvidence).not.toHaveBeenCalled();
		expect(mockApplyDatum).not.toHaveBeenCalled();
		expect(mockApplyTerminal).not.toHaveBeenCalled();
	});

	it('serializes status writes so a slow earlier state cannot overwrite a later state', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		let releaseFirst!: () => void;
		mockHydraHeadUpdateMany.mockImplementationOnce(
			async () =>
				await new Promise<{ count: number }>((resolve) => {
					releaseFirst = () => resolve({ count: 1 });
				}),
		);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);
		head.emit('StatusChange', { status: HydraHeadStatus.Open });
		head.emit('StatusChange', { status: HydraHeadStatus.Final });
		await new Promise((resolve) => setImmediate(resolve));
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledTimes(1);
		releaseFirst();
		await manager.flushHeadStatus('head-1');
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledTimes(2);
		expect(
			mockHydraHeadUpdateMany.mock.calls.map(([call]) => (call as { data: { status: string } }).data.status),
		).toEqual([HydraHeadStatus.Open, HydraHeadStatus.Final]);
	});

	it('persists a rollback frame received while websocket disconnect is in flight', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & {
			mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock; disconnect: jest.Mock };
		};
		const disconnect = jest.fn(async () => {
			head.emit('StatusChange', {
				status: HydraHeadStatus.FanoutPossible,
				headId: 'a'.repeat(56),
				snapshotNumber: 9,
			});
		});
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn(), disconnect });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
				fanoutTxHash: null,
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);
		(manager as unknown as { _heads: Map<string, unknown> })._heads.set('head-1', {
			hydraHeadId: 'head-1',
			head,
			provider: {},
		});

		await manager.disconnect('head-1');

		expect(disconnect).toHaveBeenCalledTimes(1);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: HydraHeadStatus.FanoutPossible,
					finalizedAt: null,
					reconciliationCompletedAt: null,
				}),
			}),
		);
		expect((manager as unknown as { _heads: Map<string, unknown> })._heads.has('head-1')).toBe(false);
	});

	it('does not let an older disconnect tear down a replacement transport or its status queue', async () => {
		const manager = new HydraConnectionManager();
		let signalDisconnectStarted!: () => void;
		const disconnectStarted = new Promise<void>((resolve) => {
			signalDisconnectStarted = resolve;
		});
		let finishDisconnect!: () => void;
		const disconnectFinished = new Promise<void>((resolve) => {
			finishDisconnect = resolve;
		});
		const oldMainNode = Object.assign(new EventEmitter(), {
			disconnect: jest.fn(async () => {
				signalDisconnectStarted();
				await disconnectFinished;
			}),
		});
		const oldHead = Object.assign(new EventEmitter(), { mainNode: oldMainNode });
		const replacementHead = Object.assign(new EventEmitter(), {
			mainNode: Object.assign(new EventEmitter(), { disconnect: jest.fn(async () => undefined) }),
		});
		const internal = manager as unknown as {
			_heads: Map<string, unknown>;
			_headStatusQueues: Map<string, Promise<void>>;
		};
		internal._heads.set('head-1', {
			hydraHeadId: 'head-1',
			head: oldHead,
			provider: { generation: 'old' },
		});

		const draining = manager.disconnect('head-1');
		await disconnectStarted;
		const replacementManaged = {
			hydraHeadId: 'head-1',
			head: replacementHead,
			provider: { generation: 'replacement' },
		};
		const replacementStatus = Promise.resolve();
		internal._heads.set('head-1', replacementManaged);
		internal._headStatusQueues.set('head-1', replacementStatus);
		finishDisconnect();

		await draining;

		expect(internal._heads.get('head-1')).toBe(replacementManaged);
		expect(internal._headStatusQueues.get('head-1')).toBe(replacementStatus);
		expect(oldMainNode.disconnect).toHaveBeenCalledTimes(1);
	});

	it('drains a headless rollback and removes listeners when pinned connect then rejects', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { probeNode: () => Promise<boolean> }).probeNode = async () => true;
		const localSigningKey = `5820${'11'.repeat(32)}`;
		const remoteSigningKey = `5820${'22'.repeat(32)}`;
		const configuredHead = {
			id: 'head-1',
			isEnabled: true,
			status: HydraHeadStatus.Open,
			initTxHash: 'b'.repeat(64),
			headIdentifier: 'a'.repeat(56),
			lastReconciledSnapshotSequence: null,
			lastReconciledSnapshotTransactionIndex: null,
			LocalParticipant: {
				walletId: 'local-wallet',
				nodeHttpUrl: 'http://127.0.0.1:4001',
				nodeUrl: 'ws://127.0.0.1:4001',
				HydraSecretKey: { hydraSK: encrypt(localSigningKey) },
			},
			RemoteParticipants: [
				{
					walletId: 'remote-wallet',
					HydraVerificationKey: { hydraVK: deriveHydraVerificationKeyCborHex(remoteSigningKey) },
				},
			],
			HydraRelation: {
				network: Network.Preprod,
				localHotWalletId: 'local-wallet',
				remoteWalletId: 'remote-wallet',
				LocalHotWallet: {
					deletedAt: null,
					PaymentSource: { network: Network.Preprod, deletedAt: null, disableSyncAt: null },
				},
				RemoteWallet: {
					PaymentSource: { network: Network.Preprod, deletedAt: null, disableSyncAt: null },
				},
			},
		};
		mockHydraHeadFindUnique.mockResolvedValueOnce(configuredHead).mockResolvedValueOnce({
			isEnabled: true,
			status: HydraHeadStatus.Open,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 4n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Open,
				headIdentifier: 'a'.repeat(56),
				fanoutTxHash: null,
			},
		]);
		let createdHead: CustomHydraHead | undefined;
		const connectSpy = jest.spyOn(CustomHydraHead.prototype, 'connect').mockImplementation(async function (
			this: CustomHydraHead,
		) {
			createdHead = this;
			this.emit('StatusChange', { status: HydraHeadStatus.Idle });
			throw new Error('pinned connect rejected after Idle rollback');
		});
		const nodeDisconnectSpy = jest.spyOn(HydraNode.prototype, 'disconnect').mockResolvedValue(undefined);

		try {
			await expect(manager.connect({ id: 'head-1' })).rejects.toThrow('pinned connect rejected after Idle rollback');
		} finally {
			connectSpy.mockRestore();
			nodeDisconnectSpy.mockRestore();
		}

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: HydraHeadStatus.Idle,
					isEnabled: false,
					initTxHash: null,
				}),
			}),
		);
		expect(createdHead?.listenerCount('StatusChange')).toBe(0);
		expect(createdHead?.mainNode.listenerCount('StatusChange')).toBe(0);
		expect((manager as unknown as { _headStatusQueues: Map<string, unknown> })._headStatusQueues.has('head-1')).toBe(
			false,
		);
		expect((manager as unknown as { _heads: Map<string, unknown> })._heads.has('head-1')).toBe(false);
	});

	it('persists the close admission gate when another participant closes the head', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Open,
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 0n,
		});
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Closed, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: HydraHeadStatus.Closed, isClosing: true }),
			}),
		);
	});

	it('pins a fresh head only after its identifier is durably CAS-persisted', async () => {
		const manager = new HydraConnectionManager();
		const order: string[] = [];
		const pinExpectedHeadId = jest.fn(() => order.push('pin'));
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId });
		mockHydraHeadUpdateMany.mockImplementation(async () => {
			expect(pinExpectedHeadId).not.toHaveBeenCalled();
			order.push('persist');
			return { count: 1 };
		});
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Initializing, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(order).toEqual(['persist', 'pin']);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ headIdentifier: null }),
				data: expect.objectContaining({ headIdentifier: 'a'.repeat(56) }),
			}),
		);
	});

	it('does not pin and fails closed when every durable status CAS fails', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadUpdateMany.mockResolvedValue({ count: 0 });
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Initializing, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledTimes(4);
		expect(mockHydraHeadUpdateMany).toHaveBeenLastCalledWith({
			where: { id: 'head-1' },
			data: {
				isEnabled: false,
				initTxHash: null,
				reconciliationCompletedAt: null,
			},
		});
		expect(head.mainNode.pinExpectedHeadId).not.toHaveBeenCalled();
	});

	it('rejects a head-id mismatch without mutating or pinning', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadFindUnique.mockResolvedValue({
			status: HydraHeadStatus.Initializing,
			headIdentifier: 'b'.repeat(56),
			openedAt: null,
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 0n,
		});
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Initializing, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(head.mainNode.pinExpectedHeadId).not.toHaveBeenCalled();
	});

	it('does not persist or pin a queued status after the head is disabled', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: false,
			status: HydraHeadStatus.Initializing,
			headIdentifier: null,
			openedAt: null,
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 0n,
		});
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Open, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).not.toHaveBeenCalled();
		expect(head.mainNode.pinExpectedHeadId).not.toHaveBeenCalled();
	});

	it('still invalidates finality when a queued regression observes a just-disabled head', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		const fanoutTxHash = 'f'.repeat(64);
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: false,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: false,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
				fanoutTxHash,
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.FanoutPossible, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenNthCalledWith(1, {
			where: {
				id: 'head-1',
				isEnabled: false,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
				fanoutTxHash,
			},
			data: {
				isEnabled: false,
				initTxHash: null,
				reconciliationCompletedAt: null,
			},
		});
	});

	it('atomically invalidates Final derivations when the authenticated live head rolls back to fanout-possible', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		const openedAt = new Date('2026-07-22T10:00:00Z');
		const closedAt = new Date('2026-07-22T11:00:00Z');
		const finalizedAt = new Date('2026-07-22T12:00:00Z');
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt,
			closedAt,
			finalizedAt,
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', {
			status: HydraHeadStatus.FanoutPossible,
			headId: 'a'.repeat(56),
			snapshotNumber: 9,
		});
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith({
			where: {
				id: 'head-1',
				isEnabled: true,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
			},
			data: expect.objectContaining({
				status: HydraHeadStatus.FanoutPossible,
				finalizedAt: null,
				fanoutTxHash: null,
				reconciliationCompletedAt: null,
				isClosing: true,
			}),
		});
		expect(mockPaymentRequestUpdateMany).toHaveBeenCalledWith({
			where: { hydraFanoutHandoffHeadId: 'head-1' },
			data: {
				hydraFanoutHandoffHeadId: null,
				hydraFanoutHandoffTxHash: null,
				hydraFanoutHandoffOutputIndex: null,
			},
		});
		expect(mockPurchaseRequestUpdateMany).toHaveBeenCalledTimes(1);
	});

	it('retries a serializable rollback conflict instead of dropping the authenticated frame', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
				fanoutTxHash: null,
			},
		]);
		mockPrismaTransaction.mockRejectedValueOnce(Object.assign(new Error('serialization conflict'), { code: 'P2034' }));
		const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		try {
			head.emit('StatusChange', {
				status: HydraHeadStatus.FanoutPossible,
				headId: 'a'.repeat(56),
			});
			await manager.flushHeadStatus('head-1');
		} finally {
			randomSpy.mockRestore();
		}

		expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: 'head-1', status: HydraHeadStatus.Final }),
				data: expect.objectContaining({ status: HydraHeadStatus.FanoutPossible, finalizedAt: null }),
			}),
		);
	});

	it('schedules status recovery only after the durable quarantine attempt settles', async () => {
		const manager = new HydraConnectionManager();
		const head = {} as CustomHydraHead;
		let resolveWrite!: (value: { count: number }) => void;
		let markWriteStarted!: () => void;
		const writeStarted = new Promise<void>((resolve) => {
			markWriteStarted = resolve;
		});
		const writeResult = new Promise<{ count: number }>((resolve) => {
			resolveWrite = resolve;
		});
		mockHydraHeadUpdateMany.mockImplementationOnce(async () => {
			markWriteStarted();
			return await writeResult;
		});
		const scheduleRecovery = jest
			.spyOn(
				manager as unknown as { scheduleStatusPersistenceRecovery: (hydraHeadId: string) => void },
				'scheduleStatusPersistenceRecovery',
			)
			.mockImplementation(() => undefined);

		const failClosed = (
			manager as unknown as {
				failClosedAfterStatusPersistenceFailure: (hydraHeadId: string, failedHead: CustomHydraHead) => Promise<void>;
			}
		).failClosedAfterStatusPersistenceFailure('head-1', head);
		await writeStarted;

		expect(scheduleRecovery).not.toHaveBeenCalled();
		resolveWrite({ count: 1 });
		await failClosed;
		expect(scheduleRecovery).toHaveBeenCalledWith('head-1');
	});

	it('fails closed and re-observes without deadlocking when status persistence exhausts retries', async () => {
		const manager = new HydraConnectionManager();
		const mainNode = Object.assign(new EventEmitter(), {
			disconnect: jest.fn(async () => undefined),
			pinExpectedHeadId: jest.fn(),
		});
		const head = Object.assign(new EventEmitter(), { mainNode });
		(manager as unknown as { _heads: Map<string, unknown> })._heads.set('head-1', {
			head,
			provider: {},
			hydraHeadId: 'head-1',
		});
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			initTxHash: null,
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		const conflict = Object.assign(new Error('serialization conflict'), { code: 'P2034' });
		mockPrismaTransaction.mockRejectedValue(conflict);
		const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		try {
			head.emit('StatusChange', {
				status: HydraHeadStatus.FanoutPossible,
				headId: 'a'.repeat(56),
			});
			const txOutcome = manager.handleTxConfirmed('head-1', 'tx-after-rollback');

			await expect(txOutcome).resolves.toBe('retry');
			await expect(manager.reconcileEnabledState('head-1')).resolves.toBe(false);
		} finally {
			randomSpy.mockRestore();
		}

		expect(mockTransactionFindFirst).not.toHaveBeenCalled();
		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith({
			where: { id: 'head-1' },
			data: {
				isEnabled: false,
				initTxHash: null,
				reconciliationCompletedAt: null,
			},
		});
		expect(mainNode.disconnect).toHaveBeenCalledTimes(1);
		expect(manager.isConnected('head-1')).toBe(false);
	});

	it('quarantines a contradictory post-confirmation regression without erasing adopted L1 lineage', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		const fanoutTxHash = 'f'.repeat(64);
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
				finalizedAt: new Date('2026-07-22T12:00:00Z'),
				fanoutTxHash,
				reconciliationCompletedAt: new Date('2026-07-22T12:01:00Z'),
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.FanoutPossible, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenNthCalledWith(1, {
			where: {
				id: 'head-1',
				isEnabled: true,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
				fanoutTxHash,
			},
			data: {
				isEnabled: false,
				initTxHash: null,
				reconciliationCompletedAt: null,
			},
		});
		expect(mockHydraHeadUpdateMany).toHaveBeenNthCalledWith(2, {
			where: { hydraRelationId: 'relation-1', id: { not: 'head-1' } },
			data: { isEnabled: false, initTxHash: null },
		});
		expect(mockPaymentRequestUpdateMany).not.toHaveBeenCalled();
		expect(mockPurchaseRequestUpdateMany).not.toHaveBeenCalled();
	});

	it('lowers the durable signed tip so Final 9 -> Open 8 -> Final 8 can converge', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		const finalState = {
			isEnabled: true,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		};
		mockHydraHeadFindUnique.mockResolvedValueOnce(finalState).mockResolvedValueOnce({
			...finalState,
			status: HydraHeadStatus.Open,
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 8n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Final,
				headIdentifier: 'a'.repeat(56),
				fanoutTxHash: null,
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Open, headId: 'a'.repeat(56), snapshotNumber: 8 });
		await manager.flushHeadStatus('head-1');
		head.emit('StatusChange', { status: HydraHeadStatus.Final, headId: 'a'.repeat(56), snapshotNumber: 8 });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				data: expect.objectContaining({
					status: HydraHeadStatus.Open,
					latestSnapshotNumber: 8n,
					finalizedAt: null,
				}),
			}),
		);
		expect(mockHydraHeadUpdateMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				data: expect.objectContaining({ status: HydraHeadStatus.Final, finalizedAt: expect.any(Date) }),
			}),
		);
	});

	it('quarantines both heads instead of violating the one-active-head index after a late rollback', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Final,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		const rolledBackHead = {
			id: 'head-1',
			hydraRelationId: 'relation-1',
			isEnabled: true,
			status: HydraHeadStatus.Final,
			headIdentifier: 'a'.repeat(56),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			fanoutTxHash: null,
			reconciliationCompletedAt: new Date('2026-07-22T12:01:00Z'),
		};
		mockQueryRaw.mockResolvedValueOnce([{ id: 'relation-1' }]).mockResolvedValueOnce([
			rolledBackHead,
			{
				...rolledBackHead,
				id: 'replacement-head',
				status: HydraHeadStatus.Idle,
				headIdentifier: null,
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.FanoutPossible, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				data: expect.objectContaining({
					status: HydraHeadStatus.Final,
					isEnabled: false,
					initTxHash: null,
					finalizedAt: null,
					reconciliationCompletedAt: null,
				}),
			}),
		);
		expect(mockHydraHeadUpdateMany).toHaveBeenNthCalledWith(2, {
			where: { hydraRelationId: 'relation-1', id: { not: 'head-1' } },
			data: { isEnabled: false, initTxHash: null },
		});
		const lockedHeadQuery = (
			(mockQueryRaw.mock.calls[1]?.[0] as { strings?: readonly string[] } | undefined)?.strings ?? []
		).join(' ');
		expect(lockedHeadQuery).toContain('WHERE "hydraRelationId" = ');
		expect(lockedHeadQuery).toContain('ORDER BY "id"');
		expect(lockedHeadQuery.indexOf('ORDER BY "id"')).toBeLessThan(lockedHeadQuery.indexOf('FOR UPDATE'));
	});

	it('rechecks a replacement in a fresh snapshot after the partial active-head index races', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		const durableHead = {
			id: 'head-1',
			hydraRelationId: 'relation-1',
			isEnabled: true,
			status: HydraHeadStatus.Final,
			headIdentifier: 'a'.repeat(56),
			fanoutTxHash: null,
		};
		mockHydraHeadFindUnique.mockResolvedValue({
			...durableHead,
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: new Date('2026-07-22T12:00:00Z'),
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		mockQueryRaw
			.mockResolvedValueOnce([{ id: 'relation-1' }])
			.mockResolvedValueOnce([durableHead])
			.mockResolvedValueOnce([{ id: 'relation-1' }])
			.mockResolvedValueOnce([
				durableHead,
				{
					...durableHead,
					id: 'replacement-head',
					status: HydraHeadStatus.Idle,
					headIdentifier: null,
				},
			]);
		mockHydraHeadUpdateMany
			.mockRejectedValueOnce(Object.assign(new Error('active head raced'), { code: 'P2002' }))
			.mockResolvedValue({ count: 1 });
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', {
			status: HydraHeadStatus.FanoutPossible,
			headId: 'a'.repeat(56),
		});
		await manager.flushHeadStatus('head-1');

		expect(mockPrismaTransaction).toHaveBeenCalledTimes(2);
		expect(mockHydraHeadUpdateMany).toHaveBeenLastCalledWith({
			where: { hydraRelationId: 'relation-1', id: { not: 'head-1' } },
			data: { isEnabled: false, initTxHash: null },
		});
	});

	it('reopens L2 admission metadata only when a live Closed head rolls back to Open', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Closed,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: new Date('2026-07-22T11:00:00Z'),
			finalizedAt: null,
			contestationDeadline: new Date('2026-07-22T11:30:00Z'),
			latestSnapshotNumber: 9n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Closed,
				headIdentifier: 'a'.repeat(56),
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Open, headId: 'a'.repeat(56), snapshotNumber: 9 });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: HydraHeadStatus.Open,
					closedAt: null,
					closeTxHash: null,
					contestationDeadline: null,
					isClosing: false,
				}),
			}),
		);
	});

	it('quarantines a live rollback past Open and clears its replay cursor', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Open,
			hydraRelationId: 'relation-1',
			headIdentifier: 'a'.repeat(56),
			openedAt: new Date('2026-07-22T10:00:00Z'),
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 4n,
		});
		mockQueryRaw.mockResolvedValue([
			{
				id: 'head-1',
				hydraRelationId: 'relation-1',
				isEnabled: true,
				status: HydraHeadStatus.Open,
				headIdentifier: 'a'.repeat(56),
			},
		]);
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Initializing, headId: 'a'.repeat(56) });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: HydraHeadStatus.Initializing,
					isEnabled: false,
					initTxHash: null,
					openedAt: null,
					lastReconciledSnapshotSequence: null,
					lastReconciledSnapshotTransactionIndex: null,
					latestSnapshotNumber: 0n,
				}),
			}),
		);
	});

	it('does not overwrite an existing lifecycle timestamp on a duplicate status frame', async () => {
		const manager = new HydraConnectionManager();
		const head = new EventEmitter() as EventEmitter & { mainNode: EventEmitter & { pinExpectedHeadId: jest.Mock } };
		head.mainNode = Object.assign(new EventEmitter(), { pinExpectedHeadId: jest.fn() });
		const openedAt = new Date('2026-07-22T10:00:00Z');
		mockHydraHeadFindUnique.mockResolvedValue({
			status: HydraHeadStatus.Open,
			openedAt,
			closedAt: null,
			finalizedAt: null,
			contestationDeadline: null,
			latestSnapshotNumber: 3n,
		});
		(manager as unknown as { setupEventHandlers: (id: string, value: unknown) => void }).setupEventHandlers(
			'head-1',
			head,
		);

		head.emit('StatusChange', { status: HydraHeadStatus.Open, snapshotNumber: 3 });
		await manager.flushHeadStatus('head-1');

		expect(mockHydraHeadUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.not.objectContaining({ openedAt: expect.anything() }) }),
		);
	});

	it('applies T1 then T2 from each immutable CBOR body even when the current snapshot has neither output', async () => {
		const manager = new HydraConnectionManager();
		const managedHeads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		(manager as unknown as { _heads: Map<string, unknown> })._heads = managedHeads;

		await expect(manager.handleTxConfirmed('head-1', 't1', confirmedTransaction('t1'))).resolves.toBe('applied');
		await expect(manager.handleTxConfirmed('head-1', 't2', confirmedTransaction('t2'))).resolves.toBe('applied');

		expect(mockFetchUtxos).not.toHaveBeenCalled();
		expect(mockApplyDatum).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				txId: 't1',
				network: Network.Preprod,
				outputReference: { txHash: 't1', outputIndex: 1 },
				newOnChainState: OnChainState.ResultSubmitted,
			}),
		);
		expect(mockApplyDatum).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ txId: 't2', outputReference: { txHash: 't2', outputIndex: 2 } }),
		);
	});

	it('finds and confirms a pending reservation by its exact intended hash', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { _heads: Map<string, unknown> })._heads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		mockTransactionFindFirst.mockResolvedValue({ id: 'intended-only-reservation' });
		mockTransactionFindUnique.mockResolvedValue({ status: TransactionStatus.Confirmed });

		await expect(
			manager.handleTxConfirmed('head-1', 'accepted-hash', confirmedTransaction('accepted-hash')),
		).resolves.toBe('applied');

		expect(mockTransactionFindFirst).toHaveBeenCalledWith({
			where: {
				OR: [{ txHash: 'accepted-hash' }, { txHash: null, intendedTxHash: 'accepted-hash' }],
				layer: 'L2',
				hydraHeadId: 'head-1',
				status: TransactionStatus.Pending,
			},
			select: { id: true },
		});
		expect(mockApplyDatum).toHaveBeenCalledWith(
			expect.objectContaining({
				txId: 'accepted-hash',
				transactionEvidence: expect.objectContaining({ txHash: 'accepted-hash' }),
			}),
		);
	});

	it('returns retry when confirmed CBOR cannot be parsed', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { _heads: Map<string, unknown> })._heads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		mockParseEvidence.mockReturnValue(null);

		await expect(manager.handleTxConfirmed('head-1', 'broken', confirmedTransaction('broken'))).resolves.toBe('retry');
		expect(mockFetchUtxos).not.toHaveBeenCalled();
	});

	it('keeps duplicate identifiers retryable so ambiguous lineage evidence is never discarded', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { _heads: Map<string, unknown> })._heads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		mockParseEvidence.mockReturnValue({
			inputs: [],
			spends: [],
			signerVkeys: [],
			outputs: [0, 1].map((outputIndex) => ({
				outputIndex,
				address: 'addr_test1_contract',
				amount: [{ unit: 'lovelace', quantity: '10000000' }],
				plutusData: 'd87980',
			})),
		});

		await expect(manager.handleTxConfirmed('head-1', 'duplicate', confirmedTransaction('duplicate'))).resolves.toBe(
			'retry',
		);
		expect(mockApplyDatum).not.toHaveBeenCalled();

		mockTransactionFindFirst.mockResolvedValue({ id: 'pending-1' });
		mockTransactionFindUnique.mockResolvedValue({ status: TransactionStatus.Pending });
		await expect(
			manager.handleTxConfirmed('head-1', 'duplicate-pending', confirmedTransaction('duplicate-pending')),
		).resolves.toBe('retry');
	});

	it('ignores duplicate contract outputs whose identifier has no local request', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { _heads: Map<string, unknown> })._heads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		mockFindLocallyRelevantIdentifiers.mockResolvedValue(new Set());
		mockDecodeV2ContractDatum.mockReturnValue({
			blockchainIdentifier: 'external-duplicate',
			state: SmartContractState.ResultSubmitted,
		});
		mockParseEvidence.mockReturnValue({
			txHash: 'external-dust',
			inputs: [],
			spends: [],
			signerVkeys: [],
			outputs: [0, 1].map((outputIndex) => ({
				outputIndex,
				address: 'addr_test1_contract',
				amount: [{ unit: 'lovelace', quantity: '10000000' }],
				plutusData: 'd87980',
			})),
		});

		await expect(
			manager.handleTxConfirmed('head-1', 'external-dust', confirmedTransaction('external-dust')),
		).resolves.toBe('irrelevant');
		expect(mockFindLocallyRelevantIdentifiers).toHaveBeenCalledWith('source-1', ['external-duplicate']);
		expect(mockApplyDatum).not.toHaveBeenCalled();
	});

	it('leaves a pending terminal action Pending when no exact terminal spend is proven', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { _heads: Map<string, unknown> })._heads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		mockTransactionFindFirst.mockResolvedValue({ id: 'pending-terminal' });
		mockTransactionFindUnique.mockResolvedValue({ status: TransactionStatus.Pending });
		mockParseEvidence.mockReturnValue({
			inputs: [],
			spends: [],
			outputs: [],
			signerVkeys: [],
		});

		await expect(
			manager.handleTxConfirmed('head-1', 'pending-terminal', confirmedTransaction('pending-terminal')),
		).resolves.toBe('retry');
		expect(mockApplyDatum).not.toHaveBeenCalled();
		expect(mockApplyTerminal).toHaveBeenCalled();
	});

	it('retains replay evidence when one escrow applies but another remains retryable', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { _heads: Map<string, unknown> })._heads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		mockTransactionFindFirst.mockResolvedValue({ id: 'shared-transaction' });
		mockTransactionFindUnique.mockResolvedValue({ status: TransactionStatus.Confirmed });
		mockApplyDatum.mockResolvedValue('retry');

		await expect(
			manager.handleTxConfirmed('head-1', 'partially-applied', confirmedTransaction('partially-applied')),
		).resolves.toBe('retry');
	});

	it('still applies a terminal spend when an unrelated contract output has a malformed datum', async () => {
		const manager = new HydraConnectionManager();
		(manager as unknown as { _heads: Map<string, unknown> })._heads = new Map([
			[
				'head-1',
				{
					hydraHeadId: 'head-1',
					provider: { fetchUTxOs: mockFetchUtxos },
					head: { mainNode: {} },
				},
			],
		]);
		mockDecodeV2ContractDatum.mockImplementation(() => {
			throw new Error('malformed datum');
		});
		mockApplyTerminal.mockResolvedValue('applied');

		await expect(
			manager.handleTxConfirmed('head-1', 'terminal-with-garbage', confirmedTransaction('terminal-with-garbage')),
		).resolves.toBe('applied');
		expect(mockApplyTerminal).toHaveBeenCalled();
	});
});

describe('HydraConnectionManager durable enable-state convergence', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('connects an enabled head instead of waiting for process restart', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Idle,
			initTxHash: null,
		});
		const connect = jest.spyOn(manager, 'connect').mockResolvedValue();

		await expect(manager.reconcileEnabledState('head-1')).resolves.toBe(true);

		expect(connect).toHaveBeenCalledWith({ id: 'head-1' });
	});

	it('refuses to reconnect an initialized head without independent InitTx evidence', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique.mockResolvedValue({
			isEnabled: true,
			status: HydraHeadStatus.Open,
			initTxHash: null,
		});
		const disconnect = jest.spyOn(manager, 'disconnect').mockResolvedValue();
		const connect = jest.spyOn(manager, 'connect').mockResolvedValue();

		await expect(manager.reconcileEnabledState('head-1')).resolves.toBe(false);

		expect(disconnect).toHaveBeenCalledWith('head-1');
		expect(connect).not.toHaveBeenCalled();
	});

	it('serializes stale toggles and converges to the latest durable flag', async () => {
		const manager = new HydraConnectionManager();
		mockHydraHeadFindUnique
			.mockResolvedValueOnce({ isEnabled: false, status: HydraHeadStatus.Open, initTxHash: 'a'.repeat(64) })
			.mockResolvedValueOnce({ isEnabled: true, status: HydraHeadStatus.Open, initTxHash: 'a'.repeat(64) });
		const disconnect = jest.spyOn(manager, 'disconnect').mockResolvedValue();
		const connect = jest.spyOn(manager, 'connect').mockResolvedValue();

		const staleDisable = manager.reconcileEnabledState('head-1');
		const laterEnable = manager.reconcileEnabledState('head-1');
		await Promise.all([staleDisable, laterEnable]);

		expect(disconnect.mock.invocationCallOrder[0]).toBeLessThan(connect.mock.invocationCallOrder[0]);
		expect(connect).toHaveBeenCalledWith({ id: 'head-1' });
	});
});
