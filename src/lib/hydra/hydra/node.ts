/**
 * One session against one Hydra node: the pinned websocket pair, the checks
 * every frame must pass, and the command surface the rest of the service uses.
 *
 * The node composes its collaborators rather than containing them:
 * `HydraHttpClient` talks to the Host, `HydraPartyIdentity` holds the
 * configured participant set both sockets authenticate against,
 * `LiveFrameProcessor` folds live frames into the session's current beliefs,
 * `HydraHistoryReplay` re-earns the verified state anchor on every connection
 * (ADR-0012), `ConfirmedTransactionLedger` retains bounded confirmation
 * evidence, `node-command-channel` resolves one command against the frames
 * that answer it, and `node-control-queries` reads the Host's HTTP surface.
 * What stays here is the binding: shared identity state, the fatal rotation
 * latch, connect/disconnect, and the public API.
 */
import { EventEmitter } from 'node:events';
import { UTxO } from '@meshsdk/core';

import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { hydraAuthHeaders } from './auth';
import { Connection } from './connection';
import { HydraProtocolError, HydraTransportError } from './errors';
import { ConfirmedTransactionLedger } from './node-confirmed-ledger';
import {
	HydraCommandOptions,
	awaitHydraTxConfirmation,
	prepareNewTxCommand,
	sendHydraCommandAndWait,
} from './node-command-channel';
import {
	buildHydraCommitRequest,
	fetchHydraHeadOutputTxId,
	fetchHydraProtocolParameters,
	fetchHydraRawCostModels,
	fetchHydraSnapshotUTxO,
} from './node-control-queries';
import { resolveNodeFanoutReference, resolveNodeFanoutReferences } from './node-fanout-references';
import {
	assertExpectedFrameHeadId,
	createUnsupportedPersistenceRotationError,
	isEventLogRotatedFrame,
	protocolErrorToString,
	stringMapsEqual,
} from './node-frames';
import { HydraHistoryReplay, type HistoryReplayHost } from './node-history-replay';
import { HydraHttpClient } from './node-http';
import {
	LIVE_SESSION_READY_EVENT,
	LIVE_SESSION_REJECTED_EVENT,
	LiveFrameProcessor,
	type LiveFrameHost,
} from './node-live-frames';
import { HydraPartyIdentity } from './node-party-identity';
import {
	type HydraHeadClock,
	type HydraNodeClientConfig,
	type HydraRawCostModels,
	validateHydraNodeLimits,
} from './node-api';
import { withHistorySetting } from './node-url';
import { canonicalHydraHeadIdSchema, finalizedUtxoOf, headIsFinalizedMessageSchema } from './schemas';
import { serializeHydraSnapshotOutput, type VerifiedHydraFanoutReference } from './snapshot-verification';
import { HydraConfirmedTransaction, HydraNodeEvent, HydraTransaction } from './types';

export type { HydraHeadClock, HydraNodeClientConfig, HydraRawCostModels, IHydraNode } from './node-api';

export class HydraNode extends EventEmitter {
	// Upper bound on how long init() waits to observe HeadIsInitializing after
	// posting Init. Sized for preprod's Blockfrost observation lag (the node's
	// chain-time can trail real time by minutes) while still failing fast enough
	// that a dropped InitTx surfaces as a retryable error rather than an infinite
	// hang. Overridable per-call for devnet (sub-second) or slow-sync scenarios.
	static readonly INIT_OBSERVE_TIMEOUT_MS = 300_000;
	static readonly COMMAND_RESPONSE_TIMEOUT_MS = 30_000;
	static readonly CONNECTION_TIMEOUT_MS = 10_000;
	static readonly HTTP_TIMEOUT_MS = 30_000;
	static readonly LIFECYCLE_RESPONSE_TIMEOUT_MS = 300_000;
	static readonly MAX_UNRECONCILED_CONFIRMED_TRANSACTIONS = 10_000;
	static readonly MAX_RETAINED_TRANSACTION_CBOR_BYTES = 64 * 1024 * 1024;

	/**
	 * Whether this node is in its Hydra cluster, as the node last reported.
	 *
	 * Null until it says either way. A restart replays history, so an old
	 * connectivity frame can arrive again; that is harmless here because the
	 * newest one wins and the node re-reports on every reconnect. Shared: both
	 * the live socket and replay learn it.
	 */
	private _networkConnected: boolean | null = null;
	private readonly _httpUrl: string;
	private readonly _wsUrl: string;
	private readonly _connection: Connection;
	private readonly _historyConnection: Connection;
	private _unsupportedPersistenceRotationError: HydraProtocolError | undefined;
	private _listenersAttached = false;
	private _connectionsStarted = false;
	private _connectPromise: Promise<void> | undefined;
	private _expectedHeadId: string | undefined;
	private readonly _trustLocalNodeSnapshotMetadata: boolean;
	/** Shared between live and replay sightings; they must never disagree. */
	private _finalizedFanoutOutputs: Map<string, string> | undefined;
	private readonly _connectTimeoutMs: number;
	private readonly _commandTimeoutMs: number;

	private readonly _partyIdentity: HydraPartyIdentity;
	private readonly _ledger: ConfirmedTransactionLedger;
	private readonly _replay: HydraHistoryReplay;
	private readonly _live: LiveFrameProcessor;
	private readonly _http: HydraHttpClient;

	/** Parameter drift already warned about, so a misconfigured head says it once. */
	private readonly _reportedParamsDrift = new Set<string>();

	constructor(config: HydraNodeClientConfig) {
		super();
		this._httpUrl = config.httpUrl;
		this._wsUrl = config.wsUrl ?? config.httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
		// Dedicated evidence-only history socket: replay must never feed lifecycle
		// status or command listeners, which could regress head state or stampede
		// handlers out of order. Construct the live socket last so existing test
		// harnesses that capture the latest Connection still exercise live events.
		this._historyConnection = new Connection(withHistorySetting(this._wsUrl, true), config.authToken);
		this._connection = new Connection(withHistorySetting(this._wsUrl, false), config.authToken);
		this._connectTimeoutMs = config.connectTimeoutMs ?? HydraNode.CONNECTION_TIMEOUT_MS;
		this._commandTimeoutMs = config.commandTimeoutMs ?? HydraNode.COMMAND_RESPONSE_TIMEOUT_MS;
		const httpTimeoutMs = config.httpTimeoutMs ?? HydraNode.HTTP_TIMEOUT_MS;
		const maxUnreconciledTransactions =
			config.maxUnreconciledTransactions ?? HydraNode.MAX_UNRECONCILED_CONFIRMED_TRANSACTIONS;
		const maxRetainedTransactionCborBytes =
			config.maxRetainedTransactionCborBytes ?? HydraNode.MAX_RETAINED_TRANSACTION_CBOR_BYTES;
		this._partyIdentity = new HydraPartyIdentity(config.snapshotVerificationKeys, config.expectedNodeVerificationKey);
		this._trustLocalNodeSnapshotMetadata = config.trustLocalNodeSnapshotMetadata === true;
		validateHydraNodeLimits(
			{
				connectTimeoutMs: this._connectTimeoutMs,
				httpTimeoutMs,
				commandTimeoutMs: this._commandTimeoutMs,
				maxUnreconciledTransactions,
				maxRetainedTransactionCborBytes,
			},
			config.reconciledHistoryCursor,
		);
		this._http = new HydraHttpClient({
			httpUrl: this._httpUrl,
			authHeaders: hydraAuthHeaders(config.authToken),
			timeoutMs: httpTimeoutMs,
		});
		this._ledger = new ConfirmedTransactionLedger({
			maxUnreconciledTransactions,
			maxRetainedTransactionCborBytes,
			reconciledHistoryCursor: config.reconciledHistoryCursor,
		});
		this._live = new LiveFrameProcessor(this.liveFrameHost(), this);
		this._replay = new HydraHistoryReplay(this._historyConnection, this._ledger, this.replayHost());
		if (config.expectedHeadId) this.pinExpectedHeadId(config.expectedHeadId);
	}

	/**
	 * The seams the two frame processors reach shared session state through.
	 * Getters proxy live fields — both must always see the current pinned head
	 * id and rotation latch, not the values at construction time.
	 */
	private liveFrameHost(): LiveFrameHost {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		return {
			get expectedHeadId(): string | undefined {
				return self._expectedHeadId;
			},
			get persistenceRotationError(): HydraProtocolError | undefined {
				return self._unsupportedPersistenceRotationError;
			},
			get configuredKeyCount(): number {
				return self._partyIdentity.configuredKeyCount;
			},
			assertPersistenceReplayIsSupported: (message) => this.assertPersistenceReplayIsSupported(message),
			bindSnapshotPartyOrder: (message) => this.bindSnapshotPartyOrder(message),
			verifyGreetingsPartyIdentity: (message) => this._partyIdentity.verifyGreetingsPartyIdentity(message),
			recordFinalizedFanout: (message) => this.recordFinalizedFanout(message),
			clearFinalizedFanout: () => {
				this._finalizedFanoutOutputs = undefined;
			},
			setNetworkConnected: (connected) => {
				this._networkConnected = connected;
			},
			onRotationError: (error) => this._replay.fail(error),
			invalidateLiveConnection: (error) => this._connection.invalidate(error),
		};
	}

	private replayHost(): HistoryReplayHost {
		// eslint-disable-next-line @typescript-eslint/no-this-alias
		const self = this;
		return {
			get expectedHeadId(): string | undefined {
				return self._expectedHeadId;
			},
			trustLocalNodeSnapshotMetadata: this._trustLocalNodeSnapshotMetadata,
			get persistenceRotationError(): HydraProtocolError | undefined {
				return self._unsupportedPersistenceRotationError;
			},
			get orderedSnapshotVerificationKeys(): string[] | undefined {
				return self._partyIdentity.orderedSnapshotVerificationKeys;
			},
			assertPersistenceReplayIsSupported: (message) => this.assertPersistenceReplayIsSupported(message),
			bindSnapshotPartyOrder: (message) => this.bindSnapshotPartyOrder(message),
			verifyGreetingsPartyIdentity: (message) => this._partyIdentity.verifyGreetingsPartyIdentity(message),
			setNetworkConnected: (connected) => {
				this._networkConnected = connected;
			},
			recordFinalizedFanout: (message) => this.recordFinalizedFanout(message),
			rememberReplayedDeposit: (data) => this._live.rememberReplayedDeposit(data),
			emitTxConfirmed: (txId, transaction) => {
				this.emit(HydraNodeEvent.TxConfirmed, txId, transaction);
			},
			onProtocolDrift: (description) => {
				this.emit(HydraNodeEvent.ProtocolDriftDetected, description);
			},
			onRotationReplayFailure: (error) => this.handleRotationReplayFailure(error),
			onReplayFailed: (error) => {
				this.emit(HydraNodeEvent.HistoryReplayFailed, error);
			},
		};
	}

	private handleRotationReplayFailure(error: HydraProtocolError): void {
		const { hadLiveIdentity } = this._live.clearLiveIdentity();
		if (hadLiveIdentity) this.emit(LIVE_SESSION_REJECTED_EVENT, error);
		// Rotation is permanently unsupported for this client instance. A normal
		// invalidation schedules Connection's auto-reconnect timer, so manually
		// disconnect both transports to latch their no-reconnect state instead.
		void this.disconnect().catch((disconnectError: unknown) => {
			logger.error('[HydraNode] Failed to disconnect transports after persistence rotation', {
				error: protocolErrorToString(disconnectError),
			});
		});
	}

	connect(): Promise<void> {
		if (this._unsupportedPersistenceRotationError) {
			return Promise.reject(this._unsupportedPersistenceRotationError);
		}
		if (!this._listenersAttached) {
			this._listenersAttached = true;
			this._connection.on('message', (data: string) => this._live.processStatus(data));
			this._connection.on('message', (data: string) => this._live.processHeadClock(data));
			this._connection.on('close', (reason) => {
				this._live.clearLiveIdentity();
				this.emit(
					LIVE_SESSION_REJECTED_EVENT,
					new HydraTransportError('Hydra live session closed before identity verification', { cause: reason }),
				);
			});
			this._historyConnection.on('message', (data: string) => this._replay.processMessage(data));
			this._historyConnection.on('close', () => this._replay.resetPass());
		}
		// Provider construction can call connect() again before Greetings changes
		// the protocol status. Keep transport startup independent from head status.
		if (this._connectPromise) return this._connectPromise;
		if (this._connectionsStarted && this._connection.isOpen() && this._live.isLiveSessionReady()) {
			return Promise.resolve();
		}
		this._connectionsStarted = true;
		const sessionReady = this.waitForPinnedLiveSession();
		// Claim the rejection now, not only where it is awaited below.
		// `waitUntilOpen` can reject first — a 401 from a Hydra Host's proxy does
		// exactly that — and then nothing ever awaits `sessionReady`, so the
		// rejection the socket's `close` handler raises a moment later is
		// unhandled. Node treats that as fatal, so a transport failure on one head
		// took down the whole payment service.
		sessionReady.catch(() => undefined);
		void this._historyConnection.connect().catch((error: unknown) => this._replay.fail(error));
		const connectPromise = (async () => {
			try {
				await this._connection.waitUntilOpen(this._connectTimeoutMs);
				await sessionReady;
			} catch (error) {
				this._connectionsStarted = false;
				await Promise.allSettled([this._connection.disconnect(), this._historyConnection.disconnect()]);
				throw error;
			}
		})();
		this._connectPromise = connectPromise.finally(() => {
			this._connectPromise = undefined;
		});
		return this._connectPromise;
	}

	private waitForPinnedLiveSession(): Promise<void> {
		if (this._live.isLiveSessionReady()) return Promise.resolve();

		return new Promise<void>((resolve, reject) => {
			const cleanup = () => {
				clearTimeout(timeout);
				this.removeListener(LIVE_SESSION_READY_EVENT, handleReady);
				this.removeListener(LIVE_SESSION_REJECTED_EVENT, handleRejected);
			};
			const handleReady = () => {
				cleanup();
				resolve();
			};
			const handleRejected = (error: unknown) => {
				cleanup();
				reject(
					error instanceof Error ? error : new HydraProtocolError('Hydra live session identity verification failed'),
				);
			};
			const timeout = setTimeout(() => {
				handleRejected(
					new HydraTransportError(
						`Hydra websocket did not provide a matching identity-bearing Greetings within ${this._connectTimeoutMs}ms`,
					),
				);
			}, this._connectTimeoutMs);
			this.on(LIVE_SESSION_READY_EVENT, handleReady);
			this.on(LIVE_SESSION_REJECTED_EVENT, handleRejected);
		});
	}

	private assertPersistenceReplayIsSupported(message: unknown): void {
		if (!isEventLogRotatedFrame(message)) return;
		this._unsupportedPersistenceRotationError ??= createUnsupportedPersistenceRotationError();
		throw this._unsupportedPersistenceRotationError;
	}

	get expectedHeadId(): string | undefined {
		return this._expectedHeadId;
	}

	pinExpectedHeadId(headId: string): void {
		const parsedHeadId = canonicalHydraHeadIdSchema.safeParse(headId);
		if (!parsedHeadId.success) {
			throw new HydraProtocolError('Hydra head id must be a 28-byte hexadecimal value');
		}
		if (this._expectedHeadId && this._expectedHeadId !== parsedHeadId.data) {
			throw new HydraProtocolError(
				`Hydra head id mismatch: expected ${this._expectedHeadId}, received ${parsedHeadId.data}`,
			);
		}
		if (
			(this._live.liveSessionHeadId && this._live.liveSessionHeadId !== parsedHeadId.data) ||
			(this._replay.sessionHeadId && this._replay.sessionHeadId !== parsedHeadId.data)
		) {
			throw new HydraProtocolError('Hydra head id did not match the already verified websocket sessions');
		}
		this._expectedHeadId = parsedHeadId.data;
		this._replay.processBufferedUnpinnedFrames();
	}

	private assertExpectedHeadId(message: { headId?: string; hydraHeadId?: string | null }): void {
		assertExpectedFrameHeadId(message, this._expectedHeadId);
	}

	private bindSnapshotPartyOrder(message: unknown): void {
		this._partyIdentity.bindSnapshotPartyOrder(message, (parsed) => this.assertExpectedHeadId(parsed));
	}

	/**
	 * Record the finalized L1 fanout output map, from live frame or replay
	 * alike. Both sockets can report it; they must never disagree.
	 */
	private recordFinalizedFanout(message: unknown): void {
		const parsedMessage = headIsFinalizedMessageSchema.parse(message);
		this.assertExpectedHeadId(parsedMessage);
		const fanoutOutputs = new Map<string, string>();
		for (const [reference, output] of Object.entries(finalizedUtxoOf(parsedMessage))) {
			fanoutOutputs.set(reference.toLowerCase(), serializeHydraSnapshotOutput(output));
		}
		if (this._finalizedFanoutOutputs && !stringMapsEqual(this._finalizedFanoutOutputs, fanoutOutputs)) {
			throw new HydraProtocolError('Hydra history equivocated on the finalized L1 fanout output map');
		}
		this._finalizedFanoutOutputs = fanoutOutputs;
	}

	get hasPendingIncrement(): boolean {
		return this._live.hasPendingIncrement;
	}

	get pendingIncrementUtxoRefs(): ReadonlySet<string> {
		return this._live.pendingIncrementUtxoRefs;
	}

	get headClock(): HydraHeadClock | undefined {
		return this._live.headClock;
	}

	/** See `LiveFrameProcessor.applyObservedHeadClock`: the manager's slot probe. */
	applyObservedHeadClock(chainTimeMs: number, chainSlot: number): void {
		this._live.applyObservedHeadClock(chainTimeMs, chainSlot);
	}

	get confirmedTransactionHistoryReady(): boolean {
		return this._unsupportedPersistenceRotationError == null && this._replay.isComplete;
	}

	/** Both evidence sockets have authenticated the same explicitly pinned head. */
	get hasVerifiedPinnedSessions(): boolean {
		return (
			this._unsupportedPersistenceRotationError == null &&
			this._expectedHeadId != null &&
			this._live.liveSessionHeadId === this._expectedHeadId &&
			this._replay.sessionHeadId === this._expectedHeadId &&
			this._partyIdentity.configuredKeyCount === 2 &&
			this._partyIdentity.hasExpectedNodeKey &&
			this._partyIdentity.orderedSnapshotVerificationKeys?.length === 2 &&
			this._live.livePartyIdentityVerified &&
			this._replay.partyIdentityVerified &&
			this._replay.verifiedSnapshot?.headId === this._expectedHeadId &&
			this._replay.isComplete
		);
	}

	/**
	 * Resolve a surviving in-head output to the exact L1 output observed by the
	 * Hydra chain follower. This stays unavailable unless both pinned sessions
	 * are authenticated, replay reached Greetings, the head is Final, and the
	 * signed snapshot is exactly the DB-expected final snapshot.
	 */
	getVerifiedFanoutReference(
		hydraReference: string,
		expectedSnapshotNumber: number,
	): VerifiedHydraFanoutReference | null {
		const context = this.fanoutResolutionContext(expectedSnapshotNumber);
		if (!context) return null;
		return resolveNodeFanoutReference(context, hydraReference);
	}

	getVerifiedFanoutReferences(expectedSnapshotNumber: number): VerifiedHydraFanoutReference[] | null {
		const context = this.fanoutResolutionContext(expectedSnapshotNumber);
		if (!context) return null;
		return resolveNodeFanoutReferences(context);
	}

	private fanoutResolutionContext(expectedSnapshotNumber: number) {
		const verifiedSnapshot = this._replay.verifiedSnapshot;
		if (
			!this.hasVerifiedPinnedSessions ||
			this._live.status !== HydraHeadStatus.Final ||
			!Number.isSafeInteger(expectedSnapshotNumber) ||
			expectedSnapshotNumber < 0 ||
			verifiedSnapshot?.number !== expectedSnapshotNumber ||
			this._finalizedFanoutOutputs == null
		) {
			return null;
		}
		return {
			verifiedSnapshot,
			finalizedFanoutOutputs: this._finalizedFanoutOutputs,
			getConfirmedTransaction: (txHash: string) => this.getConfirmedTransaction(txHash),
		};
	}

	get confirmedTransactionHistoryError(): Error | undefined {
		return this._unsupportedPersistenceRotationError ?? this._replay.error;
	}

	private sendCommandAndWait(options: HydraCommandOptions): Promise<void> {
		if (this._unsupportedPersistenceRotationError) {
			return Promise.reject(this._unsupportedPersistenceRotationError);
		}
		if (!this._live.isLiveSessionReady()) {
			return Promise.reject(new HydraTransportError('Hydra live session identity has not been verified'));
		}
		return sendHydraCommandAndWait(this._connection, this._expectedHeadId, options);
	}

	async init(timeoutMs: number = HydraNode.INIT_OBSERVE_TIMEOUT_MS) {
		// The head may already be initializing or open (e.g. on reconnect, or
		// when hydra-node transitions past Initializing before we observe it).
		// The node may compact old lifecycle messages even when transaction
		// history replay is enabled, so guard against waiting for a transition
		// that has already passed.
		if (this._live.status === HydraHeadStatus.Initializing || this._live.status === HydraHeadStatus.Open) {
			return;
		}

		return await this.sendCommandAndWait({
			command: 'Init',
			payload: { tag: 'Init' },
			timeoutMs,
			timeoutMessage: `Head did not reach Initializing within ${Math.round(
				timeoutMs / 1000,
			)}s of Init; reconcile the possibly submitted InitTx before retrying`,
			isComplete: (message) =>
				message.tag === 'HeadIsInitializing' ||
				message.tag === 'HeadIsOpen' ||
				(message.tag === 'Greetings' && (message.headStatus === 'Initializing' || message.headStatus === 'Open')),
		});
	}

	async commit(utxos: UTxO[] = [], blueprintTx?: string | null) {
		return await this.post<HydraTransaction>('/commit', buildHydraCommitRequest(utxos, blueprintTx));
	}

	async cardanoTransaction(transaction: HydraTransaction) {
		return await this.post('/cardano-transaction', transaction);
	}

	/**
	 * Ask the head to take this transaction's outputs out and pay them on L1.
	 *
	 * Every output leaves — there is no change staying behind — so a partial
	 * withdrawal has to split the amount off inside the head first. A 200 here
	 * means the node accepted the request, not that the head agreed: that arrives
	 * later as DecommitApproved, or does not, as DecommitInvalid.
	 */
	async decommit(transaction: HydraTransaction) {
		return await this.post('/decommit', transaction);
	}

	async snapshotUTxO(): Promise<UTxO[]> {
		return await fetchHydraSnapshotUTxO(this);
	}

	/** See `fetchHydraHeadOutputTxId`: the close (or latest fanout-step) tx. */
	async fetchHeadOutputTxId(): Promise<string | undefined> {
		const headIdentifier = this._expectedHeadId ?? this._live.liveSessionHeadId;
		if (!headIdentifier) return undefined;
		return await fetchHydraHeadOutputTxId(this, headIdentifier);
	}

	async fetchProtocolParameters() {
		return await fetchHydraProtocolParameters(this, this._reportedParamsDrift);
	}

	async fetchRawCostModels(): Promise<HydraRawCostModels> {
		return await fetchHydraRawCostModels(this);
	}

	async newTx(transaction: HydraTransaction) {
		const { txHash, commandTransaction } = prepareNewTxCommand(transaction);
		await this.sendCommandAndWait({
			command: 'NewTx',
			payload: { tag: 'NewTx', transaction: commandTransaction },
			timeoutMs: this._commandTimeoutMs,
			transactionHash: txHash,
			timeoutMessage: `Hydra did not report an outcome for transaction ${txHash} within ${this._commandTimeoutMs}ms`,
			isComplete: (message) => message.tag === 'TxValid' && message.transactionId === txHash,
		});
		return txHash;
	}

	isTxConfirmed(txHash: string): boolean {
		return this._ledger.hasConfirmed(txHash);
	}

	getConfirmedTransaction(txHash: string): HydraConfirmedTransaction | null {
		return this._ledger.getConfirmedTransaction(txHash);
	}

	getConfirmedTransactions(): HydraConfirmedTransaction[] {
		return this._unsupportedPersistenceRotationError == null && this._replay.isComplete
			? this._ledger.getAllConfirmedSorted()
			: [];
	}

	getConfirmedTransactionsForReconciliation(): HydraConfirmedTransaction[] {
		// Every queued item already passed configured-party signatures, full-state
		// accumulator verification, and a consecutive signed-state transition. It is
		// safe to durably drain a bounded page before the terminal Greetings marker;
		// destructive/live-tip inference remains separately gated on a complete pass.
		if (this._expectedHeadId == null || this._unsupportedPersistenceRotationError) return [];
		return this._ledger.getUnreconciledSorted();
	}

	markConfirmedTransactionReconciled(txHash: string): void {
		this._ledger.markReconciled(txHash);
		this._replay.maybeRestartTruncated();
	}

	async disconnect(): Promise<void> {
		await Promise.all([this._connection.disconnect(), this._historyConnection.disconnect()]);
		// Forgotten with the rest of the session state. A closed transport tells us
		// nothing about the cluster, and keeping the last frame would report the
		// counterparty as reachable long after we stopped being able to see them.
		this._networkConnected = null;
		this._live.resetOnDisconnect();
		this._replay.resetPass();
		this._ledger.clear();
		this._finalizedFanoutOutputs = undefined;
		this._replay.setErrorToRotationLatch();
		this._connectionsStarted = false;
	}

	async awaitTx(txHash: string, checkInterval: number = 1000) {
		if (!Number.isSafeInteger(checkInterval) || checkInterval <= 0) {
			throw new HydraProtocolError('Hydra confirmation polling interval must be a positive safe integer');
		}
		if (this._ledger.hasConfirmed(txHash)) return true;
		return await awaitHydraTxConfirmation({
			connections: [this._connection, this._historyConnection],
			hasConfirmed: (hash) => this._ledger.hasConfirmed(hash),
			txHash,
			checkIntervalMs: checkInterval,
			timeoutMs: this._commandTimeoutMs,
		});
	}

	async close() {
		return await this.sendCommandAndWait({
			command: 'Close',
			payload: { tag: 'Close' },
			timeoutMs: HydraNode.LIFECYCLE_RESPONSE_TIMEOUT_MS,
			timeoutMessage: 'Hydra Close outcome was not observed before the lifecycle deadline',
			isComplete: (message) => message.tag === 'HeadIsClosed',
		});
	}

	async fanout() {
		return await this.sendCommandAndWait({
			command: 'Fanout',
			payload: { tag: 'Fanout' },
			timeoutMs: HydraNode.LIFECYCLE_RESPONSE_TIMEOUT_MS,
			timeoutMessage: 'Hydra Fanout outcome was not observed before the lifecycle deadline',
			isComplete: (message) => message.tag === 'HeadIsFinalized',
		});
	}

	async get<T = unknown>(url: string): Promise<T> {
		if (this._unsupportedPersistenceRotationError) throw this._unsupportedPersistenceRotationError;
		return await this._http.get<T>(url);
	}

	async post<T = unknown>(url: string, payload: unknown): Promise<T> {
		if (this._unsupportedPersistenceRotationError) throw this._unsupportedPersistenceRotationError;
		return await this._http.post<T>(url, payload);
	}

	/**
	 * Recover a deposit the head never absorbed.
	 *
	 * A deposit that is not included by its deadline does not come back on its
	 * own: the funds stay locked at the deposit script until the node is asked to
	 * post a recover transaction.
	 */
	async delete<T = unknown>(url: string): Promise<T> {
		if (this._unsupportedPersistenceRotationError) throw this._unsupportedPersistenceRotationError;
		return await this._http.delete<T>(url);
	}

	get status() {
		return this._live.status;
	}

	/** See `_networkConnected`. Null means the node has not said yet. */
	get networkConnected(): boolean | null {
		return this._networkConnected;
	}

	get httpUrl() {
		return this._httpUrl;
	}

	get wsUrl() {
		return this._wsUrl;
	}
}
