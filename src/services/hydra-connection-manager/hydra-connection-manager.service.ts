/**
 * The registry of this process's Hydra Head sessions.
 *
 * The manager owns discovery and acquisition — which enabled heads should have
 * a session, loading and validating their configuration, wiring event handlers
 * — and delegates everything per-head to that head's `HeadSession` slot:
 * serialization queues, reconnect policy, the transport generation and the two
 * fences. Durable lifecycle writes live in `head-status-persistence` (fenced on
 * the attachment's ownerEpoch, ADR-0014); applying confirmed transactions
 * lives in `head-tx-confirmed`.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import {
	CustomHydraHead,
	HydraProvider,
	HydraHeadEvent,
	HydraNodeEvent,
	StatusChangeData,
	type DecommitSettledData,
	type DepositRecordedData,
	buildHydraHttpEndpoint,
	type HydraConfirmedTransaction,
} from '@/lib/hydra';
import { recordHeadError } from '@/services/hydra-head-error/record';
import { HydraErrorType, HydraHeadStatus, Network } from '@/generated/prisma/client';
import { HydraNodeConfig } from '@/lib/hydra/hydra/types';
import { HydraNode } from '@/lib/hydra/hydra/node';
import { applyDecommitOutcome } from '@/services/hydra-decommit/settle';
import { type HydraDatumApplyOutcome } from './hydra-datum-sync';
import { hydraAuthHeaders } from '@/lib/hydra/hydra/auth';
import { resolveHydraL2EvidenceSlotConfig } from '@/utils/hydra/l2-slot-context';
import { convertNetwork } from '@/utils/converter/network-convert';
import { probeHeadCurrentSlot } from './head-session-ops';
import { HeadSession } from './head-session';
import { persistHeadStatus, type HeadStatusPersistenceHost } from './head-status-persistence';
import { applyConfirmedHydraTransaction, type TxConfirmedHost } from './head-tx-confirmed';
import {
	HYDRA_PRE_INIT_STATUSES,
	headConfigurationInclude,
	loadValidatedHeadConfiguration,
} from './head-configuration';

export class HydraConnectionManager {
	/**
	 * One slot per head this process has ever touched. Slots are permanent for
	 * the process lifetime (matching the old per-map entries, several of which
	 * were also never deleted); the transport inside them comes and goes.
	 */
	private readonly _sessions = new Map<string, HeadSession>();

	private sessionFor(hydraHeadId: string): HeadSession {
		let session = this._sessions.get(hydraHeadId);
		if (!session) {
			session = new HeadSession(hydraHeadId);
			this._sessions.set(hydraHeadId, session);
		}
		return session;
	}

	private getSession(hydraHeadId: string): HeadSession | undefined {
		return this._sessions.get(hydraHeadId);
	}

	private readonly _txConfirmedHost: TxConfirmedHost = {
		getProvider: (hydraHeadId) => this.getProvider(hydraHeadId),
		getNode: (hydraHeadId) => this.getNode(hydraHeadId),
		flushHeadStatus: (hydraHeadId) => this.flushHeadStatus(hydraHeadId),
		isStatusQuarantined: (hydraHeadId) => this.getSession(hydraHeadId)?.isQuarantined ?? false,
	};

	async initialize(): Promise<void> {
		const enabledHeads = await prisma.hydraHead.findMany({
			where: { isEnabled: true },
			include: headConfigurationInclude,
		});

		logger.info(`[HydraConnectionManager] Found ${enabledHeads.length} enabled heads to check`);

		for (const head of enabledHeads) {
			if (!head.LocalParticipant) {
				logger.warn(`[HydraConnectionManager] Head ${head.id} has no local participant, skipping`);
				continue;
			}

			await this.reconcileEnabledState(head.id);
		}

		logger.info(`[HydraConnectionManager] Initialization complete, connected to ${this.connectedHeadIds.length} heads`);
	}

	/**
	 * Give every enabled head a session, not just the ones that existed at boot.
	 *
	 * `initialize` runs once. A head created afterwards — which is every head
	 * created from an invite — was never connected, so the issuing side sat with
	 * no session and never observed its counterparty opening the head. It stayed
	 * Idle indefinitely and the only cure was restarting the service, which is
	 * not something an operator can be expected to guess.
	 *
	 * Cheap when there is nothing to do: connecting is skipped for heads that
	 * already have a live session, so the steady state is one query.
	 */
	async reconcileMissingSessions(): Promise<number> {
		const enabledHeads = await prisma.hydraHead.findMany({
			where: { isEnabled: true, LocalParticipant: { isNot: null } },
			select: { id: true },
		});

		let reconnected = 0;
		for (const head of enabledHeads) {
			if (this.isConnected(head.id)) continue;
			try {
				await this.reconcileEnabledState(head.id);
				if (this.isConnected(head.id)) reconnected += 1;
			} catch (error) {
				// A node that is down is the ordinary case here, not an incident:
				// the next cycle tries again.
				logger.debug(`[HydraConnectionManager] Head ${head.id} still has no session: ${(error as Error).message}`);
			}
		}
		return reconnected;
	}

	/** Converge the in-memory transport to the latest durable enable flag. */
	async reconcileEnabledState(hydraHeadId: string): Promise<boolean> {
		return await this.sessionFor(hydraHeadId).runControl(
			async () => await this.reconcileEnabledStateInner(hydraHeadId),
		);
	}

	private async reconcileEnabledStateInner(hydraHeadId: string): Promise<boolean> {
		const durable = await prisma.hydraHead.findUnique({
			where: { id: hydraHeadId },
			select: { isEnabled: true, status: true, initTxHash: true },
		});
		if (!durable?.isEnabled) {
			await this.disconnect(hydraHeadId);
			this.getSession(hydraHeadId)?.clearQuarantine();
			return false;
		}
		if (durable.initTxHash == null && !HYDRA_PRE_INIT_STATUSES.has(durable.status)) {
			await this.disconnect(hydraHeadId);
			this.getSession(hydraHeadId)?.clearQuarantine();
			logger.warn(`[HydraConnectionManager] Refusing unverified initialized head ${hydraHeadId}`);
			return false;
		}
		const session = this.sessionFor(hydraHeadId);
		const attachment = session.attachment;
		if (attachment) {
			if (!session.isMutationAllowed(attachment.head)) return false;
			session.clearReconnect();
			return true;
		}

		try {
			await this.connect({ id: hydraHeadId });
			session.clearReconnect();
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
		this.sessionFor(hydraHeadId).scheduleReconnect(() => {
			void this.reconcileEnabledState(hydraHeadId).catch((error: unknown) => {
				// A warning, not an error, because the next line schedules another
				// attempt: this is the same "not reachable yet" that the first
				// attempt above logs as a warning and the sweep logs as debug, and a
				// head opening while its node is still starting hits it routinely.
				// Logging one self-healing condition at three severities taught
				// operators that a hydra error in the log means nothing.
				logger.warn('[HydraConnectionManager] Could not reconcile enabled head state; retry scheduled', {
					hydraHeadId,
					error,
				});
				this.scheduleReconnect(hydraHeadId);
			});
		});
	}

	async connect(head: { id: string }): Promise<void> {
		const session = this.sessionFor(head.id);
		await session.runConnect(() => this.connectInner(head, session, session.transportGeneration));
	}

	private async connectInner(head: { id: string }, session: HeadSession, transportGeneration: number): Promise<void> {
		const existingAttachment = session.attachment;
		if (existingAttachment) {
			if (!session.isMutationAllowed(existingAttachment.head)) {
				throw new Error(`Hydra head ${head.id} has a revoked or quarantined transport`);
			}
			logger.info(`[HydraConnectionManager] Already connected to head ${head.id}`);
			return;
		}

		const {
			configuredHead,
			nodeUrls,
			nodeAuthToken,
			localVerificationKey,
			remoteVerificationKeys,
			reconciledHistoryCursor,
		} = await loadValidatedHeadConfiguration(head.id);
		const relation = configuredHead.HydraRelation;
		const isReachable = await this.probeNode(nodeUrls.httpUrl, nodeAuthToken);
		if (!isReachable) {
			throw new Error(`Local Hydra node unreachable for head ${head.id}`);
		}
		if (session.transportGeneration !== transportGeneration) {
			throw new Error(`Hydra head ${head.id} transport was revoked while connecting`);
		}
		// Acquire the durable ownership fence for this attachment (ADR-0014): one
		// increment per acquisition, carried by every lifecycle write. Re-check the
		// process-local generation afterwards — the acquisition awaits, and a
		// disconnect during that window must still win.
		let ownerEpoch: bigint;
		try {
			({ ownerEpoch } = await prisma.hydraHead.update({
				where: { id: head.id },
				data: { ownerEpoch: { increment: 1 } },
				select: { ownerEpoch: true },
			}));
		} catch (error) {
			// P2025: the row vanished between the configuration load and the
			// acquisition. Surface the same domain error the load would have.
			if ((error as { code?: string } | null)?.code === 'P2025') {
				throw new Error(`Hydra head ${head.id} not found`);
			}
			throw error;
		}
		if (session.transportGeneration !== transportGeneration) {
			throw new Error(`Hydra head ${head.id} transport was revoked while connecting`);
		}

		const nodeConfig: HydraNodeConfig = {
			httpUrl: nodeUrls.httpUrl,
			wsUrl: nodeUrls.wsUrl,
			walletId: configuredHead.LocalParticipant.walletId,
			expectedHeadId: configuredHead.headIdentifier ?? undefined,
			reconciledHistoryCursor,
			snapshotVerificationKeys: [localVerificationKey, ...remoteVerificationKeys],
			expectedNodeVerificationKey: localVerificationKey,
			// Hydra 2.3 signs the TxOut multiset, not reference mappings or the
			// confirmed CBOR list. This opt-in names the remaining local-node trust.
			trustLocalNodeSnapshotMetadata: true,
			authToken: nodeAuthToken,
		};

		const hydraHead: CustomHydraHead = new CustomHydraHead([nodeConfig], {
			isMutationAllowed: () => session.isMutationAllowed(hydraHead),
		});
		const provider: HydraProvider = new HydraProvider({
			node: hydraHead.mainNode,
			autoConnect: false,
			isSubmissionAllowed: () => session.isMutationAllowed(hydraHead) && session.attachment?.provider === provider,
		});
		this.setupEventHandlers(head.id, hydraHead, ownerEpoch);
		session.attach({ head: hydraHead, provider, ownerEpoch });
		try {
			// Publish the attachment before transport startup: a fast Greetings or
			// TxConfirmed frame must already have handlers and provider lookup state.
			await hydraHead.connect(configuredHead.LocalParticipant.walletId);
			if (session.isQuarantined) {
				// Recovery reconnects are not admitted until the fresh authenticated
				// Greetings status has passed through the normal durable status queue.
				await this.flushHeadStatus(head.id);
				if (session.isQuarantined) {
					throw new Error(`Hydra head ${head.id} did not durably re-observe its lifecycle status`);
				}
			}
		} catch (error) {
			// A failed pinned-session handshake can still emit an authenticated
			// headless Idle Greetings that rolls durable Open state back. Keep the
			// attachment/listeners alive until that queued regression and any frame
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
				session.detachIfCurrent(hydraHead);
			}
			throw error;
		}
		logger.info(`[HydraConnectionManager] Connected to head ${head.id}` + ` via local node at ${nodeUrls.httpUrl}`);
		// Hydra 2.3 does not stream Tick/SyncedStatusReport over the API on a quiet
		// head, so the streamed head clock would only be set at connect and then go
		// stale — permanently fail-closing initial funds-lock. Keep it fresh by
		// periodically probing the node's Greetings currentSlot.
		this.startHeadClockRefresh(
			session,
			hydraHead.mainNode,
			nodeUrls.wsUrl,
			configuredHead.headIdentifier,
			relation.network,
			nodeAuthToken,
		);
	}

	private static readonly HEAD_CLOCK_REFRESH_INTERVAL_MS = 25_000;

	/**
	 * Periodically refresh a connected head's clock from a fresh Greetings
	 * `currentSlot` (converted to chain time via the L1 slot config). This is a
	 * short-lived probe socket, independent of the main transport, so it never
	 * disturbs history replay or the live session. No-op when the head's L1 slot
	 * config is unavailable.
	 */
	private startHeadClockRefresh(
		session: HeadSession,
		node: HydraNode,
		wsUrl: string,
		expectedHeadId: string | null,
		network: Network,
		authToken?: string,
	): void {
		session.stopClockRefresh();
		const slotConfig = resolveHydraL2EvidenceSlotConfig(convertNetwork(network));
		if (!slotConfig) return;
		const refresh = async (): Promise<void> => {
			try {
				const currentSlot = await probeHeadCurrentSlot(wsUrl, expectedHeadId, authToken);
				if (currentSlot == null) return;
				const chainTimeMs = slotConfig.zeroTime + (currentSlot - slotConfig.zeroSlot) * slotConfig.slotLength;
				node.applyObservedHeadClock(chainTimeMs, currentSlot);
			} catch {
				// Probe failures are non-fatal; the next tick retries and the lock
				// stays fail-closed until a fresh clock lands.
			}
		};
		session.startClockRefresh(HydraConnectionManager.HEAD_CLOCK_REFRESH_INTERVAL_MS, () => void refresh());
	}

	async disconnect(hydraHeadId: string): Promise<void> {
		const session = this.sessionFor(hydraHeadId);
		// Invalidate a connect that has read durable enablement but has not yet
		// published its transport. Once a transport is published, this synchronous
		// generation bump is followed by the exact-instance command fence below.
		session.bumpTransportGeneration();
		session.clearReconnect();
		session.stopClockRefresh();
		const attachment = session.attachment;
		if (!attachment) {
			return;
		}
		// Revoke captured command/provider references before waiting for status
		// drain or websocket shutdown. A later transport uses a different head
		// instance, so this fence does not block reconnect mechanics.
		session.revokeCommands(attachment.head);

		// Keep lifecycle listeners attached until both sockets are closed. A live
		// rollback Greetings can arrive while websocket shutdown is in flight; if
		// listeners are removed first, DB can retain false Final/completion state
		// forever after the transport disappears.
		await this.flushHeadStatus(hydraHeadId);
		try {
			await attachment.head.mainNode.disconnect();
		} finally {
			await this.flushHeadStatus(hydraHeadId);
			attachment.head.removeAllListeners();
			attachment.head.mainNode.removeAllListeners();
			// The revocation fence is instance-based and only meaningful while the
			// attachment still holds this instance; `detachIfCurrent` drops both so
			// a newer attachment is unaffected.
			session.detachIfCurrent(attachment.head);
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
		await this.sessionFor(hydraHeadId).runControl(async () => {
			await this.disconnect(hydraHeadId);
			return false;
		});
	}

	/** Wait until every status frame already queued for this head is durable. */
	async flushHeadStatus(hydraHeadId: string): Promise<void> {
		const session = this.getSession(hydraHeadId);
		if (session) await session.flushStatus();
	}

	getHead(hydraHeadId: string): CustomHydraHead | null {
		const session = this.getSession(hydraHeadId);
		const attachment = session?.attachment;
		if (!session || !attachment || !session.isMutationAllowed(attachment.head)) return null;
		return attachment.head;
	}

	getNode(hydraHeadId: string): HydraNode | null {
		return this.getHead(hydraHeadId)?.mainNode ?? null;
	}

	getProvider(hydraHeadId: string): HydraProvider | null {
		const session = this.getSession(hydraHeadId);
		const attachment = session?.attachment;
		if (!session || !attachment || !session.isMutationAllowed(attachment.head)) return null;
		return attachment.provider;
	}

	get connectedHeadIds(): string[] {
		return Array.from(this._sessions)
			.filter(([, session]) => {
				const attachment = session.attachment;
				return attachment != null && session.isMutationAllowed(attachment.head);
			})
			.map(([hydraHeadId]) => hydraHeadId);
	}

	isConnected(hydraHeadId: string): boolean {
		return this.getHead(hydraHeadId) != null;
	}

	async shutdown(): Promise<void> {
		logger.info('[HydraConnectionManager] Shutting down all connections');
		for (const [headId, session] of this._sessions) {
			if (session.attachment) await this.disconnect(headId);
			session.stopClockRefresh();
		}
	}

	private async probeNode(httpUrl: string, authToken?: string, timeoutMs = 5000): Promise<boolean> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await fetch(buildHydraHttpEndpoint(httpUrl, 'protocol-parameters'), {
				signal: controller.signal,
				// A Host rejects an unauthenticated probe, which would otherwise look
				// exactly like an unreachable node and disable a healthy head.
				headers: { 'Content-Type': 'application/json', ...hydraAuthHeaders(authToken) },
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

	private setupEventHandlers(hydraHeadId: string, head: CustomHydraHead, ownerEpoch: bigint): void {
		const session = this.sessionFor(hydraHeadId);
		const persistenceHost: HeadStatusPersistenceHost = {
			quarantine: (failedHead) => session.quarantine(failedHead),
			clearQuarantineAfterReobservation: (observingHead) => session.clearQuarantineAfterReobservation(observingHead),
			scheduleRecovery: () => this.scheduleStatusPersistenceRecovery(hydraHeadId),
			onStaleOwner: () => {
				// A newer session owns this head durably. Tear down without touching
				// the durable row, then re-read durable enablement through the control
				// queue. Single-instance, the stale epoch means this process already
				// re-acquired the head (a connect raced a disconnect), so reconciling
				// self-heals the race; under Phase 2 the lease gate will decide
				// whether re-attachment is permitted (ADR-0014).
				this.scheduleStatusPersistenceRecovery(hydraHeadId);
			},
		};
		head.on(HydraHeadEvent.StatusChange, (data: StatusChangeData) => {
			session.enqueueStatus(async () => await persistHeadStatus(persistenceHost, hydraHeadId, head, ownerEpoch, data));
		});

		// Funds that were promised to a deposit have just become spendable. Anything
		// that was waiting on them should run now rather than on the next tick.
		// A rejected history is the most consequential failure this service has and
		// used to be its quietest: the session never forms, so there is no head
		// clock, so every L2 escrow operation fails closed — while the connection
		// retries forever and the head goes on reporting itself as Open. Recorded
		// as a head error so the reason is visible where an operator is already
		// looking, instead of only in a log line they have no reason to read.
		head.mainNode.on(HydraNodeEvent.HistoryReplayFailed, (error: unknown) => {
			void recordHeadError(
				hydraHeadId,
				HydraHeadStatus.Connecting,
				HydraErrorType.CommandFailed,
				error,
				'HistoryReplay',
			).catch((recordError: unknown) => {
				logger.error('[HydraConnectionManager] could not record a rejected history replay', {
					hydraHeadId,
					error: recordError instanceof Error ? recordError.message : recordError,
				});
			});
		});

		head.mainNode.on(HydraNodeEvent.IncrementFinalized, () => {
			this.runL2PassesNow(hydraHeadId);
		});

		// A withdrawal's outcome. The request that asked for it returned long ago —
		// possibly in a process that has since restarted — so this is the only place
		// its record is ever completed.
		head.mainNode.on(HydraNodeEvent.DecommitSettled, (data: DecommitSettledData) => {
			void applyDecommitOutcome({
				hydraHeadId,
				decommitTxId: data.decommitTxId,
				outcome: data.outcome,
				reason: data.reason,
				distributed: data.distributed,
				observedAt: data.observedAt,
			}).catch((error: unknown) => {
				logger.error('[HydraConnectionManager] could not record a withdrawal outcome', {
					hydraHeadId,
					decommitTxId: data.decommitTxId,
					outcome: data.outcome,
					error: error instanceof Error ? error.message : error,
				});
			});
		});

		// The deadline the head holds a deposit to, which only the head knows: it
		// is written into the deposit datum from the drafting node's chain time,
		// and neither the deposit transaction nor the moment the operator asked
		// for the top-up can reproduce it. Recorded for the head's own deposits
		// and the counterparty's alike, since the frame does not distinguish them
		// — the update simply matches nothing for a deposit that is not ours.
		head.mainNode.on(HydraNodeEvent.DepositRecorded, (data: DepositRecordedData) => {
			void prisma.hydraTopup
				.updateMany({
					where: { hydraHeadId, depositTxHash: data.depositTxId, nodeDeadline: null },
					data: { nodeDeadline: data.deadline },
				})
				.catch((error: unknown) => {
					logger.error('[HydraConnectionManager] could not record a deposit deadline', {
						hydraHeadId,
						depositTxId: data.depositTxId,
						error: error instanceof Error ? error.message : error,
					});
				});
		});

		head.mainNode.on(HydraNodeEvent.TxConfirmed, (txId: string, confirmedTransaction?: HydraConfirmedTransaction) => {
			void (async () => {
				try {
					const outcome = await this.handleTxConfirmed(hydraHeadId, txId, confirmedTransaction);
					// Applying a confirmation is what releases the wallet that submitted
					// it, and a head has one participating wallet per side, so the next
					// purchase in the queue was very likely waiting on exactly this. The
					// lock it wants takes under a second inside the head; without this it
					// would wait for the batch timer instead, and an auto-routed purchase
					// that waits long enough is taken by the L1 pass — settled on chain
					// with an open head sitting idle.
					if (outcome === 'applied') this.runL2PassesNow(hydraHeadId);
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
	 * Start every in-head pass now instead of at the next batch tick.
	 *
	 * Called whenever something a pass was blocked on has just changed: a deposit
	 * has folded in and its funds became spendable, or a confirmation has released
	 * the wallet the head transacts with. Neither is visible to a timer.
	 *
	 * Every pass, not only the lock: a head has one participating wallet per side,
	 * so a confirmation unblocks whatever that side had queued, whether that is
	 * locking funds, submitting a result, or collecting. Nudging the lock alone
	 * left the rest on their own timers — fifteen seconds by default — which made
	 * submitting a result an order of magnitude slower than locking the funds it
	 * answers, inside the same head.
	 *
	 * Fire-and-forget by design. The batch tick is still the backstop, so a
	 * failure here costs latency and nothing else.
	 */
	private runL2PassesNow(hydraHeadId: string): void {
		// Loaded on demand: the nudge reaches the payment-source services, and
		// importing that graph here would drag the whole settlement stack into
		// every consumer of the connection manager.
		void import('@/services/hydra-nudge')
			.then(({ nudgeAllHydraCycles }) => nudgeAllHydraCycles())
			.catch((error: unknown) => {
				logger.warn('[HydraConnectionManager] could not run the L2 passes on demand', {
					hydraHeadId,
					error: error instanceof Error ? error.message : error,
				});
			});
	}

	/**
	 * Tear down a transport after lifecycle persistence exhausts its retry
	 * budget, then re-read durable enablement through the per-head control
	 * queue. This method is deliberately fire-and-forget: awaiting disconnect
	 * from the current status work would make disconnect's flush await itself.
	 */
	private scheduleStatusPersistenceRecovery(hydraHeadId: string): void {
		const work = this.sessionFor(hydraHeadId).runControl(async () => {
			await this.disconnect(hydraHeadId);
			return await this.reconcileEnabledStateInner(hydraHeadId);
		});
		void work.catch((error: unknown) => {
			logger.error('[HydraConnectionManager] Failed lifecycle-persistence recovery', {
				hydraHeadId,
				error,
			});
			this.scheduleReconnect(hydraHeadId);
		});
	}

	async handleTxConfirmed(
		hydraHeadId: string,
		txId: string,
		confirmedTransaction?: HydraConfirmedTransaction,
	): Promise<HydraDatumApplyOutcome> {
		return await this.sessionFor(hydraHeadId).runTxConfirmed(
			txId,
			async () => await applyConfirmedHydraTransaction(this._txConfirmedHost, hydraHeadId, txId, confirmedTransaction),
		);
	}
}

let _connectionManager: HydraConnectionManager | null = null;

export function getHydraConnectionManager(): HydraConnectionManager {
	if (!_connectionManager) {
		_connectionManager = new HydraConnectionManager();
	}
	return _connectionManager;
}
