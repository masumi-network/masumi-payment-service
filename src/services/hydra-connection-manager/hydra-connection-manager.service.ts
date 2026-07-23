import { prisma } from '@masumi/payment-core/db';
import { isUniqueConstraintError, retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { logger } from '@masumi/payment-core/logger';
import { withSerializableSlotRetry } from '@masumi/payment-core/serializable-semaphore';
import {
	CustomHydraHead,
	HydraProvider,
	HydraHeadEvent,
	HydraNodeEvent,
	StatusChangeData,
	buildHydraHttpEndpoint,
	getHydraPlaintextHosts,
	type HydraConfirmedTransaction,
	validateHydraNodeUrls,
} from '@/lib/hydra';
import {
	deriveHydraVerificationKeyCborHex,
	normalizeHydraVerificationKeyCborHex,
} from '@/lib/hydra/hydra/snapshot-verification';
import { HydraHeadStatus, Network, OnChainState, Prisma, TransactionStatus } from '@/generated/prisma/client';
import { HydraHeadUpdateInput } from '@/generated/prisma/models';
import { HydraNodeConfig } from '@/lib/hydra/hydra/types';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { deserializeDatum } from '@meshsdk/core';
import { decodeV2ContractDatum } from '@/utils/converter/string-datum-convert';
import { smartContractStateToOnChainState } from '@/utils/logic/l2-datum-validation';
import {
	applyDatumStateToLocalRequests,
	applyTerminalHydraSpends,
	findLocallyRelevantHydraRequestIdentifiers,
	type HydraDatumApplyOutcome,
} from './hydra-datum-sync';
import { parseHydraTransactionEvidence } from './hydra-transaction-evidence';
import { decrypt } from '@/utils/security/encryption';

interface ManagedHead {
	head: CustomHydraHead;
	provider: HydraProvider;
	hydraHeadId: string;
}

const HYDRA_HEAD_STATUS_RANK: Record<HydraHeadStatus, number> = {
	[HydraHeadStatus.Disconnected]: 0,
	[HydraHeadStatus.Connected]: 0,
	[HydraHeadStatus.Connecting]: 0,
	[HydraHeadStatus.Idle]: 0,
	[HydraHeadStatus.Initializing]: 1,
	[HydraHeadStatus.Open]: 2,
	[HydraHeadStatus.Closed]: 3,
	[HydraHeadStatus.FanoutPossible]: 4,
	[HydraHeadStatus.Final]: 5,
};

const HYDRA_RECONNECT_INITIAL_DELAY_MS = 1_000;
const HYDRA_RECONNECT_MAX_DELAY_MS = 30_000;
const HYDRA_PRE_INIT_STATUSES = new Set<HydraHeadStatus>([
	HydraHeadStatus.Disconnected,
	HydraHeadStatus.Connecting,
	HydraHeadStatus.Connected,
	HydraHeadStatus.Idle,
]);

type LockedHydraHeadLifecycle = {
	id: string;
	hydraRelationId: string;
	isEnabled: boolean;
	status: HydraHeadStatus;
	headIdentifier: string | null;
	fanoutTxHash: string | null;
};

type RegressiveStatusResult =
	| 'persisted'
	| 'quarantined-confirmed-finality-conflict'
	| 'quarantined-relation-conflict'
	| 'not-regressive'
	| 'ignored';

export interface HydraHeadWithLocalParticipant {
	id: string;
	isEnabled?: boolean;
	status?: HydraHeadStatus;
	initTxHash?: string | null;
	headIdentifier?: string | null;
	lastReconciledSnapshotSequence?: bigint | null;
	lastReconciledSnapshotTransactionIndex?: number | null;
	LocalParticipant?: {
		walletId: string;
		nodeHttpUrl: string;
		nodeUrl: string;
		HydraSecretKey: { hydraSK: string };
	} | null;
	RemoteParticipants?: Array<{
		walletId: string;
		HydraVerificationKey: { hydraVK: string };
	}>;
	HydraRelation?: {
		network: Network;
		localHotWalletId: string;
		remoteWalletId: string;
		LocalHotWallet: {
			deletedAt: Date | null;
			PaymentSource: { network: Network; deletedAt: Date | null; disableSyncAt: Date | null };
		};
		RemoteWallet: {
			PaymentSource: { network: Network; deletedAt: Date | null; disableSyncAt: Date | null };
		};
	};
}

const hydraRelationSecuritySelect = {
	network: true,
	localHotWalletId: true,
	remoteWalletId: true,
	LocalHotWallet: {
		select: {
			deletedAt: true,
			PaymentSource: { select: { network: true, deletedAt: true, disableSyncAt: true } },
		},
	},
	RemoteWallet: {
		select: {
			PaymentSource: { select: { network: true, deletedAt: true, disableSyncAt: true } },
		},
	},
} as const;

function resolvePersistedHistoryCursor(
	head: HydraHeadWithLocalParticipant,
): { snapshotSequence: number; snapshotTransactionIndex: number } | undefined {
	const sequence = head.lastReconciledSnapshotSequence;
	const index = head.lastReconciledSnapshotTransactionIndex;
	if (sequence == null && index == null) return undefined;
	if (sequence == null || index == null || sequence < 0n || !Number.isSafeInteger(index) || index < 0) {
		throw new Error(`Hydra head ${head.id} has an invalid persisted reconciliation cursor`);
	}
	const sequenceNumber = Number(sequence);
	if (!Number.isSafeInteger(sequenceNumber)) {
		throw new Error(`Hydra head ${head.id} reconciliation cursor exceeds the supported sequence range`);
	}
	return { snapshotSequence: sequenceNumber, snapshotTransactionIndex: index };
}

export class HydraConnectionManager {
	private _heads: Map<string, ManagedHead> = new Map();
	private _reconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
	private _reconnectAttempts: Map<string, number> = new Map();
	private _headConnectWork: Map<string, Promise<void>> = new Map();
	private _transportGeneration: Map<string, number> = new Map();
	private _headControlQueues: Map<string, Promise<boolean>> = new Map();
	private _txWorkById: Map<string, Promise<HydraDatumApplyOutcome>> = new Map();
	private _headTxQueues: Map<string, Promise<unknown>> = new Map();
	private _headStatusQueues: Map<string, Promise<void>> = new Map();
	private _statusPersistenceQuarantine: Map<string, CustomHydraHead> = new Map();
	private _commandRevokedHeads: Map<string, CustomHydraHead> = new Map();

	async initialize(): Promise<void> {
		const enabledHeads = await prisma.hydraHead.findMany({
			where: { isEnabled: true },
			include: {
				LocalParticipant: { include: { HydraSecretKey: true } },
				RemoteParticipants: { include: { HydraVerificationKey: true } },
				HydraRelation: { select: hydraRelationSecuritySelect },
			},
		});

		logger.info(`[HydraConnectionManager] Found ${enabledHeads.length} enabled heads to check`);

		for (const head of enabledHeads) {
			if (!head.LocalParticipant) {
				logger.warn(`[HydraConnectionManager] Head ${head.id} has no local participant, skipping`);
				continue;
			}

			await this.reconcileEnabledState(head.id);
		}

		logger.info(`[HydraConnectionManager] Initialization complete, connected to ${this._heads.size} heads`);
	}

	/** Converge the in-memory transport to the latest durable enable flag. */
	async reconcileEnabledState(hydraHeadId: string): Promise<boolean> {
		const previous = this._headControlQueues.get(hydraHeadId) ?? Promise.resolve(false);
		const work = previous.catch(() => false).then(async () => await this.reconcileEnabledStateInner(hydraHeadId));
		this._headControlQueues.set(hydraHeadId, work);
		try {
			return await work;
		} finally {
			if (this._headControlQueues.get(hydraHeadId) === work) this._headControlQueues.delete(hydraHeadId);
		}
	}

	private async reconcileEnabledStateInner(hydraHeadId: string): Promise<boolean> {
		const durable = await prisma.hydraHead.findUnique({
			where: { id: hydraHeadId },
			select: { isEnabled: true, status: true, initTxHash: true },
		});
		if (!durable?.isEnabled) {
			await this.disconnect(hydraHeadId);
			this._statusPersistenceQuarantine.delete(hydraHeadId);
			return false;
		}
		if (durable.initTxHash == null && !HYDRA_PRE_INIT_STATUSES.has(durable.status)) {
			await this.disconnect(hydraHeadId);
			this._statusPersistenceQuarantine.delete(hydraHeadId);
			logger.warn(`[HydraConnectionManager] Refusing unverified initialized head ${hydraHeadId}`);
			return false;
		}
		const managed = this._heads.get(hydraHeadId);
		if (managed) {
			if (!this.isManagedHeadMutationAllowed(hydraHeadId, managed.head)) return false;
			this.clearReconnect(hydraHeadId);
			return true;
		}

		try {
			await this.connect({ id: hydraHeadId });
			this.clearReconnect(hydraHeadId);
			return true;
		} catch (error) {
			logger.warn(`[HydraConnectionManager] Enabled head ${hydraHeadId} is not connected; retry scheduled`, {
				error,
			});
			this.scheduleReconnect(hydraHeadId);
			return false;
		}
	}

	private scheduleReconnect(hydraHeadId: string): void {
		if (this._reconnectTimers.has(hydraHeadId)) return;
		const attempt = this._reconnectAttempts.get(hydraHeadId) ?? 0;
		const delay = Math.min(HYDRA_RECONNECT_MAX_DELAY_MS, HYDRA_RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(attempt, 10));
		this._reconnectAttempts.set(hydraHeadId, attempt + 1);
		const timer = setTimeout(() => {
			this._reconnectTimers.delete(hydraHeadId);
			void this.reconcileEnabledState(hydraHeadId).catch((error: unknown) => {
				logger.error('[HydraConnectionManager] Failed to reconcile enabled head state', {
					hydraHeadId,
					error,
				});
				this.scheduleReconnect(hydraHeadId);
			});
		}, delay);
		timer.unref?.();
		this._reconnectTimers.set(hydraHeadId, timer);
	}

	private clearReconnect(hydraHeadId: string): void {
		const timer = this._reconnectTimers.get(hydraHeadId);
		if (timer) clearTimeout(timer);
		this._reconnectTimers.delete(hydraHeadId);
		this._reconnectAttempts.delete(hydraHeadId);
	}

	async connect(head: Pick<HydraHeadWithLocalParticipant, 'id'>): Promise<void> {
		const existingWork = this._headConnectWork.get(head.id);
		if (existingWork) {
			await existingWork;
			return;
		}
		const transportGeneration = this._transportGeneration.get(head.id) ?? 0;
		const work = this.connectInner(head, transportGeneration);
		this._headConnectWork.set(head.id, work);
		try {
			await work;
		} finally {
			if (this._headConnectWork.get(head.id) === work) this._headConnectWork.delete(head.id);
		}
	}

	private async connectInner(
		head: Pick<HydraHeadWithLocalParticipant, 'id'>,
		transportGeneration: number,
	): Promise<void> {
		const existingManagedHead = this._heads.get(head.id);
		if (existingManagedHead) {
			if (!this.isManagedHeadMutationAllowed(head.id, existingManagedHead.head)) {
				throw new Error(`Hydra head ${head.id} has a revoked or quarantined transport`);
			}
			logger.info(`[HydraConnectionManager] Already connected to head ${head.id}`);
			return;
		}

		const configuredHead = await prisma.hydraHead.findUnique({
			where: { id: head.id },
			include: {
				LocalParticipant: { include: { HydraSecretKey: true } },
				RemoteParticipants: { include: { HydraVerificationKey: true } },
				HydraRelation: { select: hydraRelationSecuritySelect },
			},
		});
		if (!configuredHead) {
			throw new Error(`Hydra head ${head.id} not found`);
		}
		if (configuredHead.isEnabled !== true) {
			throw new Error(`Hydra head ${head.id} is disabled`);
		}
		if (configuredHead.initTxHash == null && !HYDRA_PRE_INIT_STATUSES.has(configuredHead.status)) {
			throw new Error(`Hydra head ${head.id} has not passed independent InitTx verification`);
		}
		if (!configuredHead.LocalParticipant) {
			throw new Error('No local participant provided');
		}
		if (configuredHead.RemoteParticipants.length !== 1) {
			throw new Error('Hydra two-party heads require exactly one configured remote participant verification key');
		}
		if (
			configuredHead.LocalParticipant.walletId !== configuredHead.HydraRelation.localHotWalletId ||
			configuredHead.RemoteParticipants[0].walletId !== configuredHead.HydraRelation.remoteWalletId
		) {
			throw new Error('Hydra participants did not match the wallets bound by their Hydra relation');
		}
		const relation = configuredHead.HydraRelation;
		const localPaymentSource = relation.LocalHotWallet.PaymentSource;
		const remotePaymentSource = relation.RemoteWallet.PaymentSource;
		if (relation.network !== localPaymentSource.network || relation.network !== remotePaymentSource.network) {
			throw new Error('Hydra relation and participant payment sources must use the same network');
		}
		if (
			relation.LocalHotWallet.deletedAt !== null ||
			localPaymentSource.deletedAt !== null ||
			remotePaymentSource.deletedAt !== null ||
			localPaymentSource.disableSyncAt !== null ||
			remotePaymentSource.disableSyncAt !== null
		) {
			throw new Error('Hydra relation participants must belong to active, sync-enabled payment sources');
		}
		const decryptedSigningKey = decrypt(configuredHead.LocalParticipant.HydraSecretKey.hydraSK);
		const localVerificationKey = deriveHydraVerificationKeyCborHex(decryptedSigningKey);
		const remoteVerificationKeys = configuredHead.RemoteParticipants.map(({ HydraVerificationKey }) => {
			try {
				return normalizeHydraVerificationKeyCborHex(HydraVerificationKey.hydraVK);
			} catch (plaintextError) {
				// Compatibility for rows created by the legacy seed/reconciliation
				// scripts, which encrypted this public key by mistake.
				try {
					return normalizeHydraVerificationKeyCborHex(decrypt(HydraVerificationKey.hydraVK));
				} catch {
					throw plaintextError;
				}
			}
		});

		const nodeUrls = validateHydraNodeUrls(
			configuredHead.LocalParticipant.nodeHttpUrl,
			configuredHead.LocalParticipant.nodeUrl,
			{
				plaintextHosts: getHydraPlaintextHosts(),
			},
		);
		const isReachable = await this.probeNode(nodeUrls.httpUrl);
		if (!isReachable) {
			throw new Error(`Local Hydra node unreachable for head ${head.id}`);
		}
		if ((this._transportGeneration.get(head.id) ?? 0) !== transportGeneration) {
			throw new Error(`Hydra head ${head.id} transport was revoked while connecting`);
		}

		const nodeConfig: HydraNodeConfig = {
			httpUrl: nodeUrls.httpUrl,
			wsUrl: nodeUrls.wsUrl,
			walletId: configuredHead.LocalParticipant.walletId,
			expectedHeadId: configuredHead.headIdentifier ?? undefined,
			reconciledHistoryCursor: resolvePersistedHistoryCursor(configuredHead),
			snapshotVerificationKeys: [localVerificationKey, ...remoteVerificationKeys],
			expectedNodeVerificationKey: localVerificationKey,
			// Hydra 2.3 signs the TxOut multiset, not reference mappings or the
			// confirmed CBOR list. This opt-in names the remaining local-node trust.
			trustLocalNodeSnapshotMetadata: true,
		};

		const hydraHead: CustomHydraHead = new CustomHydraHead([nodeConfig], {
			isMutationAllowed: () => this.isManagedHeadMutationAllowed(head.id, hydraHead),
		});
		const provider: HydraProvider = new HydraProvider({
			node: hydraHead.mainNode,
			autoConnect: false,
			isSubmissionAllowed: () =>
				this.isManagedHeadMutationAllowed(head.id, hydraHead) && this._heads.get(head.id)?.provider === provider,
		});
		this.setupEventHandlers(head.id, hydraHead);
		this._heads.set(head.id, {
			head: hydraHead,
			provider,
			hydraHeadId: head.id,
		});
		try {
			// Publish the managed head before transport startup: a fast Greetings or
			// TxConfirmed frame must already have handlers and provider lookup state.
			await hydraHead.connect(configuredHead.LocalParticipant.walletId);
			if (this._statusPersistenceQuarantine.has(head.id)) {
				// Recovery reconnects are not admitted until the fresh authenticated
				// Greetings status has passed through the normal durable status queue.
				await this.flushHeadStatus(head.id);
				if (this._statusPersistenceQuarantine.has(head.id)) {
					throw new Error(`Hydra head ${head.id} did not durably re-observe its lifecycle status`);
				}
			}
		} catch (error) {
			// A failed pinned-session handshake can still emit an authenticated
			// headless Idle Greetings that rolls durable Open state back. Keep the
			// managed entry/listeners alive until that queued regression and any frame
			// received during socket shutdown have both been persisted.
			await this.flushHeadStatus(head.id);
			try {
				await hydraHead.mainNode.disconnect();
			} catch (disconnectError) {
				logger.warn('[HydraConnectionManager] Failed to close transport after connect failure', {
					hydraHeadId: head.id,
					disconnectError,
				});
			} finally {
				await this.flushHeadStatus(head.id);
				hydraHead.removeAllListeners();
				hydraHead.mainNode.removeAllListeners();
				if (this._heads.get(head.id)?.head === hydraHead) {
					this._headStatusQueues.delete(head.id);
					this._heads.delete(head.id);
				}
			}
			throw error;
		}
		logger.info(`[HydraConnectionManager] Connected to head ${head.id}` + ` via local node at ${nodeUrls.httpUrl}`);
	}

	async disconnect(hydraHeadId: string): Promise<void> {
		// Invalidate a connect that has read durable enablement but has not yet
		// published its transport. Once a transport is published, this synchronous
		// generation bump is followed by the exact-instance command fence below.
		this._transportGeneration.set(hydraHeadId, (this._transportGeneration.get(hydraHeadId) ?? 0) + 1);
		this.clearReconnect(hydraHeadId);
		const managed = this._heads.get(hydraHeadId);
		if (!managed) {
			return;
		}
		// Revoke captured command/provider references before waiting for status
		// drain or websocket shutdown. A later transport uses a different head
		// instance, so this fence does not block reconnect mechanics.
		this._commandRevokedHeads.set(hydraHeadId, managed.head);

		// Keep lifecycle listeners attached until both sockets are closed. A live
		// rollback Greetings can arrive while websocket shutdown is in flight; if
		// listeners are removed first, DB can retain false Final/completion state
		// forever after the transport disappears.
		await this.flushHeadStatus(hydraHeadId);
		try {
			await managed.head.mainNode.disconnect();
		} finally {
			await this.flushHeadStatus(hydraHeadId);
			managed.head.removeAllListeners();
			managed.head.mainNode.removeAllListeners();
			if (this._heads.get(hydraHeadId)?.head === managed.head) {
				this._headStatusQueues.delete(hydraHeadId);
				this._heads.delete(hydraHeadId);
			}
			// The revocation fence is instance-based and only meaningful while
			// `_heads` still holds this instance (isManagedHeadMutationAllowed
			// requires `_heads.get(id)?.head === head` first). Drop the retained
			// object once the transport is gone; a newer instance is unaffected.
			if (this._commandRevokedHeads.get(hydraHeadId) === managed.head) {
				this._commandRevokedHeads.delete(hydraHeadId);
			}
		}

		logger.info(`[HydraConnectionManager] Disconnected from head ${hydraHeadId}`);
	}

	/**
	 * Disconnect serialized through the per-head control queue so it cannot
	 * interleave with a queued `reconcileEnabledState` (a direct disconnect could
	 * otherwise be immediately undone by an already-queued reconcile re-attaching
	 * the transport). Use from periodic/reconciler contexts; `shutdown()` keeps
	 * the direct path for immediate teardown.
	 */
	async queueDisconnect(hydraHeadId: string): Promise<void> {
		const previous = this._headControlQueues.get(hydraHeadId) ?? Promise.resolve(false);
		const work = previous
			.catch(() => false)
			.then(async () => {
				await this.disconnect(hydraHeadId);
				return false;
			});
		this._headControlQueues.set(hydraHeadId, work);
		try {
			await work;
		} finally {
			if (this._headControlQueues.get(hydraHeadId) === work) this._headControlQueues.delete(hydraHeadId);
		}
	}

	/** Wait until every status frame already queued for this head is durable. */
	async flushHeadStatus(hydraHeadId: string): Promise<void> {
		while (true) {
			const queued = this._headStatusQueues.get(hydraHeadId);
			if (!queued) return;
			await queued.catch(() => undefined);
			if (this._headStatusQueues.get(hydraHeadId) === queued) return;
		}
	}

	getHead(hydraHeadId: string): CustomHydraHead | null {
		const managed = this._heads.get(hydraHeadId);
		if (!managed || !this.isManagedHeadMutationAllowed(hydraHeadId, managed.head)) return null;
		return managed.head;
	}

	getNode(hydraHeadId: string): HydraNode | null {
		const managed = this._heads.get(hydraHeadId);
		if (!managed || !this.isManagedHeadMutationAllowed(hydraHeadId, managed.head)) return null;
		return managed.head.mainNode;
	}

	getProvider(hydraHeadId: string): HydraProvider | null {
		const managed = this._heads.get(hydraHeadId);
		if (!managed || !this.isManagedHeadMutationAllowed(hydraHeadId, managed.head)) return null;
		return managed.provider;
	}

	get connectedHeadIds(): string[] {
		return Array.from(this._heads)
			.filter(([hydraHeadId, managed]) => this.isManagedHeadMutationAllowed(hydraHeadId, managed.head))
			.map(([hydraHeadId]) => hydraHeadId);
	}

	isConnected(hydraHeadId: string): boolean {
		const managed = this._heads.get(hydraHeadId);
		return managed != null && this.isManagedHeadMutationAllowed(hydraHeadId, managed.head);
	}

	private isManagedHeadMutationAllowed(hydraHeadId: string, head: CustomHydraHead): boolean {
		return (
			this._heads.get(hydraHeadId)?.head === head &&
			!this._statusPersistenceQuarantine.has(hydraHeadId) &&
			this._commandRevokedHeads.get(hydraHeadId) !== head
		);
	}

	async shutdown(): Promise<void> {
		logger.info('[HydraConnectionManager] Shutting down all connections');
		for (const [headId] of this._heads) {
			await this.disconnect(headId);
		}
	}

	private async probeNode(httpUrl: string, timeoutMs = 5000): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(buildHydraHttpEndpoint(httpUrl, 'protocol-parameters'), {
				signal: controller.signal,
				headers: { 'Content-Type': 'application/json' },
				redirect: 'error',
			});
			await response.body?.cancel().catch(() => undefined);
			return response.ok;
		} catch {
			return false;
		} finally {
			clearTimeout(timeout);
		}
	}

	private setupEventHandlers(hydraHeadId: string, head: CustomHydraHead): void {
		head.on(HydraHeadEvent.StatusChange, (data: StatusChangeData) => {
			const previous = this._headStatusQueues.get(hydraHeadId) ?? Promise.resolve();
			const work = previous
				.catch(() => undefined)
				.then(async () => await this.persistHeadStatus(hydraHeadId, head, data));
			this._headStatusQueues.set(hydraHeadId, work);
			void work.finally(() => {
				if (this._headStatusQueues.get(hydraHeadId) === work) this._headStatusQueues.delete(hydraHeadId);
			});
		});

		head.mainNode.on(HydraNodeEvent.TxConfirmed, (txId: string, confirmedTransaction?: HydraConfirmedTransaction) => {
			void (async () => {
				try {
					await this.handleTxConfirmed(hydraHeadId, txId, confirmedTransaction);
				} catch (error) {
					logger.error('[HydraConnectionManager] Error handling confirmed tx', {
						txId,
						hydraHeadId,
						error,
					});
				}
			})();
		});
	}

	/**
	 * Tear down a transport after lifecycle persistence exhausts its retry
	 * budget, then re-read durable enablement through the per-head control
	 * queue. This method is deliberately fire-and-forget: awaiting disconnect
	 * from the current status work would make disconnect's flush await itself.
	 */
	private scheduleStatusPersistenceRecovery(hydraHeadId: string): void {
		const previous = this._headControlQueues.get(hydraHeadId) ?? Promise.resolve(false);
		const work = previous
			.catch(() => false)
			.then(async () => {
				await this.disconnect(hydraHeadId);
				return await this.reconcileEnabledStateInner(hydraHeadId);
			});
		this._headControlQueues.set(hydraHeadId, work);
		void work
			.catch((error: unknown) => {
				logger.error('[HydraConnectionManager] Failed lifecycle-persistence recovery', {
					hydraHeadId,
					error,
				});
				this.scheduleReconnect(hydraHeadId);
			})
			.finally(() => {
				if (this._headControlQueues.get(hydraHeadId) === work) this._headControlQueues.delete(hydraHeadId);
			});
	}

	private clearStatusPersistenceQuarantineAfterReobservation(
		hydraHeadId: string,
		observingHead: CustomHydraHead,
	): void {
		const failedHead = this._statusPersistenceQuarantine.get(hydraHeadId);
		if (failedHead != null && failedHead !== observingHead) {
			this._statusPersistenceQuarantine.delete(hydraHeadId);
		}
	}

	private async failClosedAfterStatusPersistenceFailure(
		hydraHeadId: string,
		failedHead: CustomHydraHead,
	): Promise<void> {
		// A missed rollback below Open would otherwise leave stale init evidence
		// available to L2 sync/submission. Block local access immediately, then
		// durably disable the head when the database still accepts a simple write.
		// Recovery is queued without awaiting it so status work cannot deadlock on
		// disconnect's flush of that same queue.
		this._statusPersistenceQuarantine.set(hydraHeadId, failedHead);
		try {
			await retryOnSerializationConflict(
				async () =>
					await prisma.hydraHead.updateMany({
						where: { id: hydraHeadId },
						data: {
							isEnabled: false,
							initTxHash: null,
							reconciliationCompletedAt: null,
						},
					}),
				{ label: 'hydra-status-persistence-fail-closed' },
			);
		} catch (quarantineError) {
			logger.error('[HydraConnectionManager] Failed to durably quarantine head after status persistence error', {
				hydraHeadId,
				quarantineError,
			});
		} finally {
			// Start recovery only after the durable quarantine attempt settles. If
			// it ran earlier, a fast disconnect/re-read could reconnect and clear
			// the local fence before the successful disable write became visible.
			this.scheduleStatusPersistenceRecovery(hydraHeadId);
		}
	}

	/**
	 * Persist an authenticated live lifecycle rollback while holding the same
	 * head-row lock used by final reconciliation. Hydra history replay never
	 * emits StatusChange; a lower-ranked frame here therefore describes the
	 * local node's current L1 view rather than an old history item.
	 */
	private async persistRegressiveHeadStatus(
		hydraHeadId: string,
		hydraRelationId: string,
		status: HydraHeadStatus,
		headId: string | undefined,
		snapshotNumber: number | undefined,
	): Promise<RegressiveStatusResult> {
		const persistAttempt = async (): Promise<RegressiveStatusResult> =>
			await prisma.$transaction(
				async (tx) => {
					// Head creation/deletion use the relation as their first lock. Match that
					// order, then lock every sibling in canonical order. The all-head
					// fence matches cleanup/replacement writers and prevents inverse
					// target-head -> sibling-head waits during relation quarantine.
					const relations = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
						SELECT "id" FROM "HydraRelation"
						WHERE "id" = ${hydraRelationId}
						FOR UPDATE
					`);
					if (relations.length !== 1) return 'ignored';
					const rows = await tx.$queryRaw<LockedHydraHeadLifecycle[]>(Prisma.sql`
						SELECT "id", "hydraRelationId", "isEnabled", "status", "headIdentifier", "fanoutTxHash"
						FROM "HydraHead"
						WHERE "hydraRelationId" = ${hydraRelationId}
						ORDER BY "id"
						FOR UPDATE
					`);
					const current = rows.find((row) => row.id === hydraHeadId);
					if (!current) return 'ignored';
					if (headId && current.headIdentifier != null && current.headIdentifier !== headId) return 'ignored';
					if (HYDRA_HEAD_STATUS_RANK[status] >= HYDRA_HEAD_STATUS_RANK[current.status]) {
						return 'not-regressive';
					}
					if (current.fanoutTxHash != null) {
						// The fanout hash is written only after configured L1 confirmation depth,
						// in the same transaction that adopts every surviving request onto L1.
						// That lineage cannot be reconstructed from a contradictory node frame.
						// Preserve it, invalidate cleanup eligibility, and quarantine the entire
						// relation for explicit operator/reorg recovery.
						const quarantined = await tx.hydraHead.updateMany({
							where: {
								id: hydraHeadId,
								isEnabled: current.isEnabled,
								status: current.status,
								headIdentifier: current.headIdentifier,
								fanoutTxHash: current.fanoutTxHash,
							},
							data: {
								isEnabled: false,
								initTxHash: null,
								reconciliationCompletedAt: null,
							},
						});
						if (quarantined.count !== 1) {
							throw new Error('Confirmed Hydra fanout rollback quarantine lost the locked head row');
						}
						await tx.hydraHead.updateMany({
							where: { hydraRelationId, id: { not: hydraHeadId } },
							data: { isEnabled: false, initTxHash: null },
						});
						return 'quarantined-confirmed-finality-conflict';
					}

					const targetRank = HYDRA_HEAD_STATUS_RANK[status];
					const updateData: HydraHeadUpdateInput = {
						status,
						latestActivityAt: new Date(),
					};
					if (snapshotNumber != null) {
						if (!Number.isSafeInteger(snapshotNumber) || snapshotNumber < 0) return 'ignored';
						// Unlike stale history, an authenticated live regression can also roll
						// back the signed snapshot tip. Forward persistence is monotonic, so the
						// lower tip must be written explicitly here or re-finalization wedges.
						updateData.latestSnapshotNumber = BigInt(snapshotNumber);
					}

					if (targetRank < HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Final]) {
						// A rolled-back fanout invalidates every derived completion/adoption
						// token. Clear request handoffs in this transaction so deletion and
						// L1 adoption can never observe a half-invalidated Final head.
						updateData.finalizedAt = null;
						updateData.fanoutTxHash = null;
						updateData.reconciliationCompletedAt = null;
						const clearHandoff = {
							hydraFanoutHandoffHeadId: null,
							hydraFanoutHandoffTxHash: null,
							hydraFanoutHandoffOutputIndex: null,
						};
						await tx.paymentRequest.updateMany({
							where: { hydraFanoutHandoffHeadId: hydraHeadId },
							data: clearHandoff,
						});
						await tx.purchaseRequest.updateMany({
							where: { hydraFanoutHandoffHeadId: hydraHeadId },
							data: clearHandoff,
						});
					}

					if (targetRank < HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Closed]) {
						updateData.closedAt = null;
						updateData.closeTxHash = null;
						updateData.contestationDeadline = null;
						updateData.isClosing = false;
					} else {
						updateData.isClosing = true;
					}

					if (targetRank < HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Open]) {
						// A rollback past Open invalidates the L2 ledger itself. Quarantine the
						// head and discard its replay cursor; explicit re-enable must first
						// perform a fresh independent InitTx attestation.
						updateData.openedAt = null;
						updateData.isEnabled = false;
						updateData.initTxHash = null;
						updateData.lastReconciledSnapshotSequence = null;
						updateData.lastReconciledSnapshotTransactionIndex = null;
						updateData.latestSnapshotNumber = 0n;
					}

					const replacementHead = rows.find((row) => row.id !== hydraHeadId && row.status !== HydraHeadStatus.Final);
					if (replacementHead) {
						// The partial unique index cannot represent both the rolled-back old
						// head and an already-created replacement as non-Final. Preserve the
						// schema invariant, invalidate the false finality markers, and quarantine
						// every head in the relation for explicit operator recovery.
						const invalidated = await tx.hydraHead.updateMany({
							where: {
								id: hydraHeadId,
								isEnabled: current.isEnabled,
								status: current.status,
								headIdentifier: current.headIdentifier,
							},
							data: {
								...updateData,
								status: current.status,
								isEnabled: false,
								initTxHash: null,
							},
						});
						if (invalidated.count !== 1) {
							throw new Error('Hydra rollback invalidation lost ownership of the locked head row');
						}
						await tx.hydraHead.updateMany({
							where: { hydraRelationId, id: { not: hydraHeadId } },
							data: { isEnabled: false, initTxHash: null },
						});
						return 'quarantined-relation-conflict';
					}

					const updated = await tx.hydraHead.updateMany({
						where: {
							id: hydraHeadId,
							isEnabled: current.isEnabled,
							status: current.status,
							headIdentifier: current.headIdentifier,
						},
						data: updateData,
					});
					if (updated.count !== 1) {
						throw new Error('Hydra rollback persistence lost ownership of the locked head row');
					}
					return 'persisted';
				},
				{
					isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
					maxWait: 15_000,
					timeout: 15_000,
				},
			);

		try {
			return await withSerializableSlotRetry(persistAttempt, { label: 'hydra-live-status-rollback' });
		} catch (error) {
			if (!isUniqueConstraintError(error)) throw error;
			// A replacement creator can commit while this Serializable attempt is
			// waiting for the relation lock. PostgreSQL's fixed snapshot may then
			// miss that new row and surface the partial one-active-head index as
			// 23505/P2002. One fresh transaction sees the replacement and takes the
			// explicit relation-quarantine path above.
			return await withSerializableSlotRetry(persistAttempt, {
				label: 'hydra-live-status-rollback-after-replacement',
			});
		}
	}

	private async persistHeadStatus(hydraHeadId: string, head: CustomHydraHead, data: StatusChangeData): Promise<void> {
		const { status, headId, contestationDeadline, snapshotNumber } = data;
		logger.info(`[HydraConnectionManager] Head ${hydraHeadId} status changed to ${status}`, {
			headId,
			contestationDeadline,
			snapshotNumber,
		});
		try {
			if (headId && !/^[0-9a-f]{56}$/.test(headId)) {
				logger.error('[HydraConnectionManager] Rejected a non-canonical Hydra head identifier', {
					hydraHeadId,
				});
				return;
			}
			for (let attempt = 0; attempt < 3; attempt += 1) {
				const current = await prisma.hydraHead.findUnique({
					where: { id: hydraHeadId },
					select: {
						isEnabled: true,
						status: true,
						hydraRelationId: true,
						headIdentifier: true,
						openedAt: true,
						closedAt: true,
						finalizedAt: true,
						contestationDeadline: true,
						latestSnapshotNumber: true,
					},
				});
				if (!current) return;
				if (current.isEnabled === false && HYDRA_HEAD_STATUS_RANK[status] >= HYDRA_HEAD_STATUS_RANK[current.status]) {
					return;
				}
				if (headId && current.headIdentifier != null && current.headIdentifier !== headId) {
					logger.error('[HydraConnectionManager] Rejected a Hydra status frame for a different durable head', {
						hydraHeadId,
					});
					return;
				}
				if (HYDRA_HEAD_STATUS_RANK[status] < HYDRA_HEAD_STATUS_RANK[current.status]) {
					const rollbackResult = await this.persistRegressiveHeadStatus(
						hydraHeadId,
						current.hydraRelationId,
						status,
						headId,
						snapshotNumber,
					);
					if (rollbackResult === 'not-regressive') continue;
					if (rollbackResult !== 'ignored') {
						this.clearStatusPersistenceQuarantineAfterReobservation(hydraHeadId, head);
					}
					if (rollbackResult === 'persisted') {
						logger.warn('[HydraConnectionManager] Persisted authenticated live Hydra lifecycle rollback', {
							hydraHeadId,
							currentStatus: current.status,
							observedStatus: status,
						});
					}
					if (rollbackResult === 'quarantined-relation-conflict') {
						logger.error(
							'[HydraConnectionManager] Quarantined relation after rollback conflicted with replacement head',
							{
								hydraHeadId,
								hydraRelationId: current.hydraRelationId,
								currentStatus: current.status,
								observedStatus: status,
							},
						);
					}
					if (rollbackResult === 'quarantined-confirmed-finality-conflict') {
						logger.error(
							'[HydraConnectionManager] Quarantined relation after live status contradicted confirmed fanout',
							{
								hydraHeadId,
								hydraRelationId: current.hydraRelationId,
								currentStatus: current.status,
								observedStatus: status,
							},
						);
					}
					return;
				}
				const now = new Date();
				const updateData: HydraHeadUpdateInput = { status, latestActivityAt: now };
				if (HYDRA_HEAD_STATUS_RANK[status] >= HYDRA_HEAD_STATUS_RANK[HydraHeadStatus.Closed]) {
					// A peer can close the head without using this process's API. Persist the
					// admission gate from the authenticated lifecycle frame as well.
					updateData.isClosing = true;
				}
				if (headId) updateData.headIdentifier = headId;
				if (contestationDeadline && current.contestationDeadline == null) {
					// Field-level parse guard (like the head-id regex above): the schema only
					// bounds the string's length, so `new Date(garbage)` yields Invalid Date,
					// the Prisma write throws, and the catch below would fail-closed the WHOLE
					// head (durably disabled + InitTx attestation wiped) over one cosmetic
					// field from a buggy node build. Skip the field instead of nuking the head.
					const parsedDeadline = new Date(contestationDeadline);
					if (Number.isFinite(parsedDeadline.getTime())) {
						updateData.contestationDeadline = parsedDeadline;
					} else {
						logger.warn('[HydraConnectionManager] Ignoring unparseable contestationDeadline in status frame', {
							hydraHeadId,
							contestationDeadline,
						});
					}
				}
				if (snapshotNumber != null && BigInt(snapshotNumber) > current.latestSnapshotNumber) {
					updateData.latestSnapshotNumber = BigInt(snapshotNumber);
				}
				if (status === HydraHeadStatus.Open && current.openedAt == null) updateData.openedAt = now;
				else if (status === HydraHeadStatus.Closed && current.closedAt == null) updateData.closedAt = now;
				else if (status === HydraHeadStatus.Final && current.finalizedAt == null) updateData.finalizedAt = now;

				const updated = await prisma.hydraHead.updateMany({
					where: {
						id: hydraHeadId,
						isEnabled: true,
						status: current.status,
						headIdentifier: current.headIdentifier,
					},
					data: updateData,
				});
				if (updated.count === 1) {
					this.clearStatusPersistenceQuarantineAfterReobservation(hydraHeadId, head);
					// Only now may HydraNode drain history buffered before identity was
					// known: the exact head id is durably committed by the CAS above.
					if (headId) head.mainNode.pinExpectedHeadId(headId);
					return;
				}
			}
			logger.warn('[HydraConnectionManager] Head status changed concurrently; observed frame retained in logs', {
				hydraHeadId,
				status,
			});
			await this.failClosedAfterStatusPersistenceFailure(hydraHeadId, head);
		} catch (error) {
			logger.error('[HydraConnectionManager] Failed to update head status', { hydraHeadId, error });
			await this.failClosedAfterStatusPersistenceFailure(hydraHeadId, head);
		}
	}

	async handleTxConfirmed(
		hydraHeadId: string,
		txId: string,
		confirmedTransaction?: HydraConfirmedTransaction,
	): Promise<HydraDatumApplyOutcome> {
		const dedupeKey = `${hydraHeadId}:${txId}`;
		const existingWork = this._txWorkById.get(dedupeKey);
		if (existingWork) {
			logger.debug(`[HydraConnectionManager] Skipping duplicate TxConfirmed for ${txId}`);
			return await existingWork;
		}
		const previous = this._headTxQueues.get(hydraHeadId) ?? Promise.resolve();
		const work = previous
			.catch(() => undefined)
			.then(() => this._handleTxConfirmedInner(hydraHeadId, txId, confirmedTransaction));
		this._headTxQueues.set(hydraHeadId, work);
		this._txWorkById.set(dedupeKey, work);

		try {
			return await work;
		} finally {
			this._txWorkById.delete(dedupeKey);
			if (this._headTxQueues.get(hydraHeadId) === work) this._headTxQueues.delete(hydraHeadId);
		}
	}

	private async _handleTxConfirmedInner(
		hydraHeadId: string,
		txId: string,
		confirmedTransaction?: HydraConfirmedTransaction,
	): Promise<HydraDatumApplyOutcome> {
		// Lifecycle and transaction frames use separate queues, but a rollback
		// observed first must close its durable admission gate before a later
		// TxConfirmed frame can mutate escrow state.
		await this.flushHeadStatus(hydraHeadId);
		if (this._statusPersistenceQuarantine.has(hydraHeadId)) return 'retry';
		const tx = await prisma.transaction.findFirst({
			where: {
				OR: [{ txHash: txId }, { txHash: null, intendedTxHash: txId }],
				layer: 'L2',
				hydraHeadId,
				status: TransactionStatus.Pending,
			},
			select: { id: true },
		});

		if (!tx) {
			return await this.syncHydraDatumStateFromConfirmedTx(hydraHeadId, txId, confirmedTransaction);
		}

		// Every L2 state change is confirmed from immutable snapshot evidence: a
		// validated continuation datum, or an exact persisted UTxO spend with the
		// expected terminal redeemer. Never derive confirmation from the requested
		// action alone; that would turn a malformed/missing output into success.
		const syncOutcome = await this.syncHydraDatumStateFromConfirmedTx(hydraHeadId, txId, confirmedTransaction);
		if (syncOutcome === 'retry') {
			// A transaction can touch multiple local escrows. Even if one output
			// confirmed the shared Transaction row, retain the replay evidence until
			// every dependent datum/spend has reached a durable outcome.
			return 'retry';
		}
		const refreshed = await prisma.transaction.findUnique({
			where: { id: tx.id },
			select: { status: true },
		});
		if (refreshed?.status === TransactionStatus.Pending) {
			logger.warn('[HydraConnectionManager] Refusing unvalidated L2 confirmation', {
				hydraHeadId,
				txId,
			});
			return 'retry';
		}
		return refreshed?.status === TransactionStatus.Confirmed ? 'applied' : 'retry';
	}

	private async syncHydraDatumStateFromConfirmedTx(
		hydraHeadId: string,
		txId: string,
		confirmedTransaction?: HydraConfirmedTransaction,
	): Promise<HydraDatumApplyOutcome> {
		try {
			if (this._statusPersistenceQuarantine.has(hydraHeadId)) return 'retry';
			let hasApplied = false;
			let hasRetry = false;
			const provider = this.getProvider(hydraHeadId);

			const hydraHead = await prisma.hydraHead.findUnique({
				where: { id: hydraHeadId },
				include: {
					HydraRelation: {
						include: {
							LocalHotWallet: {
								include: {
									PaymentSource: true,
								},
							},
						},
					},
				},
			});

			if (!hydraHead || !hydraHead.isEnabled || hydraHead.initTxHash == null) {
				// Cross-replica disablement and independent InitTx verification are
				// durable admission boundaries. A stale local socket may retain valid
				// frames, but it must not mutate escrow state after either gate closes.
				return 'retry';
			}

			const paymentSource = hydraHead.HydraRelation.LocalHotWallet.PaymentSource;
			const network = paymentSource.network === Network.Mainnet ? 'mainnet' : 'preprod';
			const resolvedConfirmedTransaction =
				confirmedTransaction ?? this.getNode(hydraHeadId)?.getConfirmedTransaction(txId) ?? null;
			const transactionEvidence = resolvedConfirmedTransaction
				? parseHydraTransactionEvidence(resolvedConfirmedTransaction.cborHex)
				: null;
			if (resolvedConfirmedTransaction && !transactionEvidence) return 'retry';
			const confirmationTimeMs = resolvedConfirmedTransaction?.confirmedAtMs ?? null;
			type ObservedOutput = {
				input: { txHash: string; outputIndex: number };
				output: {
					address: string;
					plutusData: string | null;
					amount: Array<{ unit: string; quantity: string }>;
				};
			};
			let transactionOutputs: ObservedOutput[];
			if (transactionEvidence) {
				// Decode the confirmed transaction's own immutable outputs. Reading the
				// current snapshot by tx hash loses T1 when one snapshot confirms T1→T2.
				transactionOutputs = transactionEvidence.outputs.map((output) => ({
					input: { txHash: txId, outputIndex: output.outputIndex },
					output: {
						address: output.address,
						plutusData: output.plutusData,
						amount: output.amount,
					},
				}));
			} else if (provider) {
				transactionOutputs = (await provider.fetchUTxOs(txId)).map((utxo) => ({
					input: utxo.input,
					output: {
						address: utxo.output.address,
						plutusData: utxo.output.plutusData ?? null,
						amount: utxo.output.amount,
					},
				}));
			} else {
				transactionOutputs = [];
			}

			const contractOutputs = transactionOutputs.filter((utxo) => {
				return utxo.output.address === paymentSource.smartContractAddress && utxo.output.plutusData != null;
			});

			const decodedOutputs: Array<{
				output: (typeof contractOutputs)[number];
				decoded: NonNullable<ReturnType<typeof decodeV2ContractDatum>>;
				state: OnChainState;
			}> = [];
			for (const output of contractOutputs) {
				try {
					const outputDatum = output.output.plutusData;
					if (!outputDatum) continue;
					const decodedDatum: unknown = deserializeDatum(outputDatum);
					const decodedNewContract = decodeV2ContractDatum(decodedDatum, network, paymentSource.smartContractAddress);
					if (!decodedNewContract) continue;
					// Strict 1:1 datum-state → OnChainState (shared with the reconciler).
					const derivedOnChainState = smartContractStateToOnChainState(decodedNewContract.state);
					if (!derivedOnChainState) continue;
					decodedOutputs.push({ output, decoded: decodedNewContract, state: derivedOnChainState });
				} catch (error) {
					// Unrelated script-address outputs cannot suppress proof of a valid
					// terminal spend elsewhere in the same confirmed transaction.
					logger.warn('[HydraConnectionManager] Ignoring malformed contract output', {
						hydraHeadId,
						txId,
						outputIndex: output.input.outputIndex,
						error,
					});
				}
			}

			const identifierCounts = new Map<string, number>();
			for (const decodedOutput of decodedOutputs) {
				identifierCounts.set(
					decodedOutput.decoded.blockchainIdentifier,
					(identifierCounts.get(decodedOutput.decoded.blockchainIdentifier) ?? 0) + 1,
				);
			}
			const duplicateIdentifiers = [...identifierCounts]
				.filter(([, count]) => count > 1)
				.map(([identifier]) => identifier);
			const locallyRelevantDuplicateIdentifiers = await findLocallyRelevantHydraRequestIdentifiers(
				paymentSource.id,
				duplicateIdentifiers,
			);
			for (const decodedOutput of decodedOutputs) {
				if ((identifierCounts.get(decodedOutput.decoded.blockchainIdentifier) ?? 0) !== 1) {
					if (locallyRelevantDuplicateIdentifiers.has(decodedOutput.decoded.blockchainIdentifier)) {
						hasRetry = true;
						logger.warn('[HydraConnectionManager] duplicate outputs for local identifier; refusing ambiguous tx', {
							hydraHeadId,
							txId,
							blockchainIdentifier: decodedOutput.decoded.blockchainIdentifier,
						});
					}
					continue;
				}
				const datumOutcome = await applyDatumStateToLocalRequests({
					hydraHeadId,
					txId,
					paymentSourceId: paymentSource.id,
					network: paymentSource.network,
					decoded: decodedOutput.decoded,
					newOnChainState: decodedOutput.state,
					outputAmounts: decodedOutput.output.output.amount,
					outputReference: decodedOutput.output.input,
					transactionEvidence,
					confirmationTimeMs,
				});
				hasApplied ||= datumOutcome === 'applied';
				hasRetry ||= datumOutcome === 'retry';
			}

			if (transactionEvidence) {
				const terminalOutcome = await applyTerminalHydraSpends({
					hydraHeadId,
					txId,
					paymentSourceId: paymentSource.id,
					transactionEvidence,
				});
				hasApplied ||= terminalOutcome === 'applied';
				hasRetry ||= terminalOutcome === 'retry';
			}
			return hasRetry ? 'retry' : hasApplied ? 'applied' : 'irrelevant';
		} catch (error) {
			logger.error('[HydraConnectionManager] Failed fallback L2 datum sync', {
				hydraHeadId,
				txId,
				error,
			});
			return 'retry';
		}
	}
}

let _connectionManager: HydraConnectionManager | null = null;

export function getHydraConnectionManager(): HydraConnectionManager {
	if (!_connectionManager) {
		_connectionManager = new HydraConnectionManager();
	}
	return _connectionManager;
}
