/* eslint-disable @typescript-eslint/prefer-promise-reject-errors */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { EventEmitter } from 'node:events';
import { FixedTransaction } from '@emurgo/cardano-serialization-lib-nodejs';
import { castProtocol, Protocol, resolveTxHash, UTxO } from '@meshsdk/core';

import { mapHydraUTxOToUTxO, mapUTxOToHydraUTxO } from './codec';
import { Connection } from './connection';
import {
	canonicalHydraHeadIdSchema,
	canonicalHydraTransactionIdSchema,
	commandFailedMessageSchema,
	greetingsIdentityMessageSchema,
	headClockMessageSchema,
	headIsFinalizedMessageSchema,
	headPartiesMessageSchema,
	historyHeadIsOpenMessageSchema,
	historySnapshotConfirmedMessageSchema,
	hydraCommandTransactionSchema,
	hydraCostModelSchema,
	hydraCostModelsEnvelopeSchema,
	hydraHeadStatusSchema,
	hydraProtocolParametersSchema,
	hydraSnapshotUtxoSchema,
	MAX_HYDRA_WS_FRAME_BYTES,
	messageSchema,
	postTxOnChainFailedMessageSchema,
	txInvalidMessageSchema,
	txValidMessageSchema,
} from './schemas';
import { HydraConfirmedTransaction, HydraNodeEvent, HydraTransaction, HydraUTxO, StatusChangeData } from './types';
import {
	HydraCommandRejectedError,
	HydraProtocolError,
	HydraTransactionRejectedError,
	HydraTransportAmbiguousError,
	HydraTransportError,
} from './errors';
import {
	doesHydraTransactionTransitionReachSnapshot,
	hydraVerificationKeyRawHex,
	normalizeHydraVerificationKeyCborHex,
	resolveVerifiedHydraFanoutReference,
	resolveVerifiedHydraFanoutReferences,
	serializeCardanoTransactionOutput,
	serializeHydraSnapshotOutput,
	verifyHydraSnapshot,
	type VerifiedHydraFanoutReference,
	type VerifiedHydraSnapshot,
} from './snapshot-verification';
import { logger } from '@masumi/payment-core/logger';
import { parseHydraJson, stringifyHydraJson } from './json';
import { HydraHeadStatus } from '@/generated/prisma/client';

/**
 * The head's Plutus cost models, as returned by hydra-node's
 * `/protocol-parameters` endpoint under `costModels`. Same `{ PlutusVN: number[] }`
 * shape Blockfrost returns under `cost_models_raw`, so the V2 cost-model sync
 * helper consumes either source identically. Used to patch the V2 mesh line's
 * bundled `DEFAULT_V*_COST_MODEL_LIST` arrays so an in-head (isHydra) Plutus tx
 * computes a script-data-hash the head's ledger accepts (otherwise:
 * `PPViewHashesDontMatch`). See docs/adr/0005.
 */
export type HydraRawCostModels = {
	PlutusV1?: number[];
	PlutusV2?: number[];
	PlutusV3?: number[];
};

/**
 * The head's last observed L1 chain time, from the API websocket's
 * `Tick`/`SyncedStatusReport` broadcasts. This is the clock the head's ledger
 * checks tx validity intervals against — it can lag wall-clock time by many
 * minutes (Blockfrost-backed chain followers drift), so L2 validity windows
 * must anchor to it, not to `Date.now()`. `receivedAtMs` lets consumers judge
 * staleness.
 */
export interface HydraHeadClock {
	chainTimeMs: number;
	chainSlot?: number;
	receivedAtMs: number;
}

function withQuerySetting(url: string, key: string, value: string): string {
	const fragmentIndex = url.indexOf('#');
	const base = fragmentIndex === -1 ? url : url.slice(0, fragmentIndex);
	const fragment = fragmentIndex === -1 ? '' : url.slice(fragmentIndex);
	const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const existing = new RegExp(`([?&])${escapedKey}=[^&#]*`);
	const updated = existing.test(base)
		? base.replace(existing, `$1${key}=${value}`)
		: `${base}${base.includes('?') ? '&' : '?'}${key}=${value}`;
	return updated + fragment;
}

function withHistorySetting(url: string, history: boolean): string {
	return withQuerySetting(withQuerySetting(url, 'history', history ? 'yes' : 'no'), 'snapshot-utxo', 'yes');
}

const LIVE_SESSION_READY_EVENT = 'hydraLiveSessionReady';
const LIVE_SESSION_REJECTED_EVENT = 'hydraLiveSessionRejected';
const MAX_HYDRA_HTTP_RESPONSE_BYTES = 4 * 1024 * 1024;
const EARLIEST_PLAUSIBLE_HEAD_CLOCK_MS = Date.UTC(2017, 8, 23);
const MAX_HEAD_CLOCK_FUTURE_SKEW_MS = 5 * 60 * 1000;
const UNSUPPORTED_PERSISTENCE_ROTATION_MESSAGE =
	'Hydra persistence event-log rotation is unsupported because compacted replay cannot restore the authenticated head-state anchors';
const HISTORY_STATUS_REQUIRING_STATE_ANCHOR = new Set<HydraHeadStatus>([
	HydraHeadStatus.Open,
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.Final,
]);
const HEAD_SCOPED_SERVER_OUTPUT_TAGS = new Set([
	'HeadIsInitializing',
	'Committed',
	'HeadIsOpen',
	'HeadIsClosed',
	'HeadIsContested',
	'ReadyToFanout',
	'HeadIsAborted',
	'HeadIsFinalized',
	'TxValid',
	'TxInvalid',
	'SnapshotConfirmed',
	'IgnoredHeadInitializing',
	'DecommitRequested',
	'DecommitInvalid',
	'DecommitApproved',
	'DecommitFinalized',
	'CommitRecorded',
	'DepositActivated',
	'DepositExpired',
	'CommitApproved',
	'CommitFinalized',
	'CommitRecovered',
	'SnapshotSideLoaded',
]);

function compareConfirmedTransactions(a: HydraConfirmedTransaction, b: HydraConfirmedTransaction): number {
	const sequenceDifference =
		(a.snapshotSequence ?? Number.MAX_SAFE_INTEGER) - (b.snapshotSequence ?? Number.MAX_SAFE_INTEGER);
	if (sequenceDifference !== 0) return sequenceDifference;
	const indexDifference = a.snapshotTransactionIndex - b.snapshotTransactionIndex;
	if (indexDifference !== 0) return indexDifference;
	return a.txId.localeCompare(b.txId);
}

export interface IHydraNode {
	connect(): void | Promise<void>;
	disconnect(): Promise<void>;
	init(): Promise<unknown>;
	commit(utxos: UTxO[], blueprintTx?: string): Promise<HydraTransaction>;
	cardanoTransaction(transaction: HydraTransaction): Promise<unknown>;
	snapshotUTxO(): Promise<UTxO[]>;
	fetchProtocolParameters(): Promise<Protocol>;
	fetchRawCostModels(): Promise<HydraRawCostModels>;
	newTx(transaction: HydraTransaction): Promise<string>;
	isTxConfirmed(txHash: string): boolean;
	getConfirmedTransaction?(txHash: string): HydraConfirmedTransaction | null;
	getConfirmedTransactions?(): HydraConfirmedTransaction[];
	getConfirmedTransactionsForReconciliation?(): HydraConfirmedTransaction[];
	markConfirmedTransactionReconciled?(txHash: string): void;
	awaitTx(txHash: string, checkInterval?: number): Promise<boolean>;
	close(): Promise<unknown>;
	fanout(): Promise<unknown>;

	// Raw hydra-node HTTP responses are untyped JSON; callers pass the expected
	// shape via the type parameter (defaults to `unknown`, forcing narrowing).
	get<T = unknown>(url: string): Promise<T>;
	post<T = unknown>(url: string, payload: unknown): Promise<T>;

	get status(): HydraHeadStatus;
	get httpUrl(): string;
	get wsUrl(): string;
	get headClock(): HydraHeadClock | undefined;
	readonly hasVerifiedPinnedSessions?: boolean;
	readonly expectedHeadId?: string;
	pinExpectedHeadId?(headId: string): void;
	getVerifiedFanoutReference?(
		hydraReference: string,
		expectedSnapshotNumber: number,
	): VerifiedHydraFanoutReference | null;
	getVerifiedFanoutReferences?(expectedSnapshotNumber: number): VerifiedHydraFanoutReference[] | null;
}

export interface HydraNodeClientConfig {
	httpUrl: string;
	wsUrl?: string;
	expectedHeadId?: string;
	/** Durable high-water mark; replay entries at/before it are parsed but not retained. */
	reconciledHistoryCursor?: { snapshotSequence: number; snapshotTransactionIndex: number };
	/** Configured participant verification keys; on-chain events bind their signature order. */
	snapshotVerificationKeys?: string[];
	/** Verification key derived from this node's configured local signing key. */
	expectedNodeVerificationKey?: string;
	/**
	 * Explicit trust in this configured local endpoint's TxIn/reference map and
	 * `snapshot.confirmed` metadata. Hydra signatures commit only TxOut values.
	 */
	trustLocalNodeSnapshotMetadata?: boolean;
	/** Bounds websocket-open and pinned Greetings authentication. */
	connectTimeoutMs?: number;
	/** Bounds every Hydra HTTP request. */
	httpTimeoutMs?: number;
	/** Primarily useful for bounded integration tests; defaults to 30 seconds. */
	commandTimeoutMs?: number;
	/** Explicit fail-closed replay cap; unresolved causal evidence is never evicted. */
	maxUnreconciledTransactions?: number;
	/** Explicit aggregate budget for retained confirmation CBOR. */
	maxRetainedTransactionCborBytes?: number;
}

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
	static readonly MAX_UNPINNED_HISTORY_BUFFER_BYTES = 8 * 1024 * 1024;

	private readonly _httpUrl: string;
	private readonly _wsUrl: string;
	private readonly _confirmedTransactions = new Map<string, HydraConfirmedTransaction>();
	private readonly _unreconciledConfirmedTransactions = new Map<string, HydraConfirmedTransaction>();
	private _status: HydraHeadStatus;
	private readonly _connection: Connection;
	private readonly _historyConnection: Connection;
	private readonly _txCircularBuffer: CircularBuffer<string>;
	private _headClock: HydraHeadClock | undefined;
	private _historyReplayComplete = false;
	private _historyReplayFailed = false;
	private _historyReplayError: Error | undefined;
	private _unsupportedPersistenceRotationError: HydraProtocolError | undefined;
	private _historySessionHeadId: string | undefined;
	private _historyReplayTruncated = false;
	private _historyReplayRestartRequested = false;
	private _unpinnedHistoryFrames: string[] = [];
	private _unpinnedHistoryBytes = 0;
	private _lastHistorySequence: number | undefined;
	private _listenersAttached = false;
	private _connectionsStarted = false;
	private _connectPromise: Promise<void> | undefined;
	private _expectedHeadId: string | undefined;
	private _liveSessionHeadId: string | undefined;
	private _livePartyIdentityVerified = false;
	private _historyPartyIdentityVerified = false;
	private readonly _configuredPartyKeys: ReadonlySet<string>;
	private readonly _expectedNodeVerificationKey: string | undefined;
	private readonly _trustLocalNodeSnapshotMetadata: boolean;
	private _orderedSnapshotVerificationKeys: string[] | undefined;
	private _verifiedHistorySnapshot: VerifiedHydraSnapshot | undefined;
	private _finalizedFanoutOutputs: Map<string, string> | undefined;
	private _currentSnapshotProducerTxIds = new Set<string>();
	private _currentSnapshotProducerSnapshotNumber: number | undefined;
	private _cursorPrefixProducerTxIds = new Set<string>();
	private readonly _connectTimeoutMs: number;
	private readonly _httpTimeoutMs: number;
	private readonly _commandTimeoutMs: number;
	private readonly _maxUnreconciledTransactions: number;
	private readonly _maxRetainedTransactionCborBytes: number;
	private _reconciledHistoryCursor: { snapshotSequence: number; snapshotTransactionIndex: number } | undefined;

	constructor(config: HydraNodeClientConfig) {
		super();
		this._httpUrl = config.httpUrl;
		this._wsUrl = config.wsUrl ?? config.httpUrl.replace('http://', 'ws://').replace('https://', 'wss://');
		this._status = HydraHeadStatus.Disconnected;
		// Dedicated evidence-only history socket: replay must never feed lifecycle
		// status or command listeners, which could regress head state or stampede
		// handlers out of order. Construct the live socket last so existing test
		// harnesses that capture the latest Connection still exercise live events.
		this._historyConnection = new Connection(withHistorySetting(this._wsUrl, true));
		this._connection = new Connection(withHistorySetting(this._wsUrl, false));
		this._txCircularBuffer = new CircularBuffer(10000);
		this._connectTimeoutMs = config.connectTimeoutMs ?? HydraNode.CONNECTION_TIMEOUT_MS;
		this._httpTimeoutMs = config.httpTimeoutMs ?? HydraNode.HTTP_TIMEOUT_MS;
		this._commandTimeoutMs = config.commandTimeoutMs ?? HydraNode.COMMAND_RESPONSE_TIMEOUT_MS;
		this._maxUnreconciledTransactions =
			config.maxUnreconciledTransactions ?? HydraNode.MAX_UNRECONCILED_CONFIRMED_TRANSACTIONS;
		this._maxRetainedTransactionCborBytes =
			config.maxRetainedTransactionCborBytes ?? HydraNode.MAX_RETAINED_TRANSACTION_CBOR_BYTES;
		this._reconciledHistoryCursor = config.reconciledHistoryCursor ? { ...config.reconciledHistoryCursor } : undefined;
		const configuredPartyKeys = (config.snapshotVerificationKeys ?? []).map((key) => {
			return hydraVerificationKeyRawHex(normalizeHydraVerificationKeyCborHex(key));
		});
		if (new Set(configuredPartyKeys).size !== configuredPartyKeys.length) {
			throw new HydraProtocolError('Hydra snapshot verification keys must be unique');
		}
		this._configuredPartyKeys = new Set(configuredPartyKeys);
		this._expectedNodeVerificationKey = config.expectedNodeVerificationKey
			? hydraVerificationKeyRawHex(normalizeHydraVerificationKeyCborHex(config.expectedNodeVerificationKey))
			: undefined;
		this._trustLocalNodeSnapshotMetadata = config.trustLocalNodeSnapshotMetadata === true;
		if (
			(this._configuredPartyKeys.size > 0 || this._expectedNodeVerificationKey != null) &&
			(this._expectedNodeVerificationKey == null || !this._configuredPartyKeys.has(this._expectedNodeVerificationKey))
		) {
			throw new HydraProtocolError('Hydra local verification key must belong to the configured participant set');
		}
		if (
			this._reconciledHistoryCursor &&
			(!Number.isSafeInteger(this._reconciledHistoryCursor.snapshotSequence) ||
				this._reconciledHistoryCursor.snapshotSequence < 0 ||
				!Number.isSafeInteger(this._reconciledHistoryCursor.snapshotTransactionIndex) ||
				this._reconciledHistoryCursor.snapshotTransactionIndex < 0)
		) {
			throw new Error('reconciledHistoryCursor must contain non-negative safe integers');
		}
		if (!Number.isSafeInteger(this._connectTimeoutMs) || this._connectTimeoutMs <= 0) {
			throw new Error('connectTimeoutMs must be a positive safe integer');
		}
		if (!Number.isSafeInteger(this._httpTimeoutMs) || this._httpTimeoutMs <= 0) {
			throw new Error('httpTimeoutMs must be a positive safe integer');
		}
		if (!Number.isSafeInteger(this._commandTimeoutMs) || this._commandTimeoutMs <= 0) {
			throw new Error('commandTimeoutMs must be a positive safe integer');
		}
		if (!Number.isSafeInteger(this._maxUnreconciledTransactions) || this._maxUnreconciledTransactions <= 0) {
			throw new Error('maxUnreconciledTransactions must be a positive safe integer');
		}
		if (!Number.isSafeInteger(this._maxRetainedTransactionCborBytes) || this._maxRetainedTransactionCborBytes <= 0) {
			throw new Error('maxRetainedTransactionCborBytes must be a positive safe integer');
		}
		if (config.expectedHeadId) this.pinExpectedHeadId(config.expectedHeadId);
	}

	connect(): Promise<void> {
		if (this._unsupportedPersistenceRotationError) {
			return Promise.reject(this._unsupportedPersistenceRotationError);
		}
		if (!this._listenersAttached) {
			this._listenersAttached = true;
			this._connection.on('message', (data) => this.processStatus(data));
			this._connection.on('message', (data) => this.processHeadClock(data));
			this._connection.on('close', (reason) => {
				this._liveSessionHeadId = undefined;
				this._livePartyIdentityVerified = false;
				this._headClock = undefined;
				this.emit(
					LIVE_SESSION_REJECTED_EVENT,
					new HydraTransportError('Hydra live session closed before identity verification', { cause: reason }),
				);
			});
			this._historyConnection.on('message', (data) => this.processHistoryMessage(data));
			this._historyConnection.on('close', () => this.resetHistoryReplayPass());
		}
		// Provider construction can call connect() again before Greetings changes
		// the protocol status. Keep transport startup independent from head status.
		if (this._connectPromise) return this._connectPromise;
		if (this._connectionsStarted && this._connection.isOpen() && this.isLiveSessionReady()) {
			return Promise.resolve();
		}
		this._connectionsStarted = true;
		const sessionReady = this.waitForPinnedLiveSession();
		void this._historyConnection.connect().catch((error: unknown) => this.failHistoryReplay(error));
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
		if (this.isLiveSessionReady()) return Promise.resolve();

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

	private isLiveSessionReady(): boolean {
		const isHeadReady = this._expectedHeadId == null || this._liveSessionHeadId === this._expectedHeadId;
		const requiresIdentityBearingGreetings = this._expectedHeadId != null || this._configuredPartyKeys.size > 0;
		const isPartyReady = !requiresIdentityBearingGreetings || this._livePartyIdentityVerified;
		return this._unsupportedPersistenceRotationError == null && isHeadReady && isPartyReady;
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
			(this._liveSessionHeadId && this._liveSessionHeadId !== parsedHeadId.data) ||
			(this._historySessionHeadId && this._historySessionHeadId !== parsedHeadId.data)
		) {
			throw new HydraProtocolError('Hydra head id did not match the already verified websocket sessions');
		}
		this._expectedHeadId = parsedHeadId.data;
		this.processBufferedUnpinnedHistoryFrames();
	}

	private assertExpectedHeadId(message: { headId?: string; hydraHeadId?: string | null }): void {
		assertExpectedFrameHeadId(message, this._expectedHeadId);
	}

	private bindSnapshotPartyOrder(message: unknown): void {
		if (this._configuredPartyKeys.size === 0) return;
		const parsed = headPartiesMessageSchema.parse(message);
		this.assertExpectedHeadId(parsed);
		const orderedKeys = parsed.parties.map(({ vkey }) => vkey);
		if (
			orderedKeys.length !== this._configuredPartyKeys.size ||
			new Set(orderedKeys).size !== orderedKeys.length ||
			orderedKeys.some((key) => !this._configuredPartyKeys.has(key))
		) {
			throw new HydraProtocolError('Hydra on-chain party set did not match the configured verification keys');
		}
		if (
			this._orderedSnapshotVerificationKeys &&
			this._orderedSnapshotVerificationKeys.some((key, index) => key !== orderedKeys[index])
		) {
			throw new HydraProtocolError('Hydra on-chain party order changed within one configured head');
		}
		this._orderedSnapshotVerificationKeys = orderedKeys;
	}

	private verifyGreetingsPartyIdentity(message: unknown): void {
		if (this._configuredPartyKeys.size === 0) return;
		const parsed = greetingsIdentityMessageSchema.parse(message);
		const localKey = this._expectedNodeVerificationKey;
		if (localKey == null || parsed.me.vkey !== localKey || parsed.env.party.vkey !== localKey) {
			throw new HydraProtocolError('Hydra Greetings did not identify the configured local signing key');
		}
		const otherKeys = parsed.env.otherParties.map(({ vkey }) => vkey);
		const expectedOtherKeys = [...this._configuredPartyKeys].filter((key) => key !== localKey);
		if (
			otherKeys.length !== expectedOtherKeys.length ||
			new Set(otherKeys).size !== otherKeys.length ||
			otherKeys.some((key) => !this._configuredPartyKeys.has(key) || key === localKey)
		) {
			throw new HydraProtocolError('Hydra Greetings party set did not match the configured participants');
		}
	}

	private failHistoryReplay(error: unknown): void {
		const normalizedError =
			error instanceof HydraProtocolError || error instanceof HydraTransportError
				? error
				: new HydraProtocolError('Hydra history replay failed protocol validation', { cause: error });
		const isFirstFailure = !this._historyReplayFailed;
		this._historyReplayFailed = true;
		this._historyReplayComplete = false;
		this._historyReplayError = normalizedError;
		this._unpinnedHistoryFrames = [];
		this._unpinnedHistoryBytes = 0;
		const isUnsupportedPersistenceRotation = normalizedError === this._unsupportedPersistenceRotationError;
		if (isUnsupportedPersistenceRotation) {
			const hadLiveIdentity = this._liveSessionHeadId != null || this._livePartyIdentityVerified;
			this._liveSessionHeadId = undefined;
			this._livePartyIdentityVerified = false;
			this._headClock = undefined;
			if (hadLiveIdentity) this.emit(LIVE_SESSION_REJECTED_EVENT, normalizedError);
			// Rotation is permanently unsupported for this client instance. A normal
			// invalidation schedules Connection's auto-reconnect timer, so manually
			// disconnect both transports to latch their no-reconnect state instead.
			void this.disconnect().catch((disconnectError: unknown) => {
				logger.error('[HydraNode] Failed to disconnect transports after persistence rotation', {
					error: protocolErrorToString(disconnectError),
				});
			});
		}
		if (isFirstFailure) {
			this.emit(HydraNodeEvent.HistoryReplayFailed, normalizedError);
			logger.error('[HydraNode] History replay rejected a protocol frame', {
				error: protocolErrorToString(normalizedError),
			});
			if (!isUnsupportedPersistenceRotation) {
				// A malformed pass must never remain latched on the same byte stream.
				// Connection invalidation closes the bad socket and schedules a clean replay.
				this._historyConnection.invalidate(normalizedError);
			}
		}
	}

	private resetHistoryReplayPass(): void {
		// A replacement history socket always scans from the beginning. Preserve
		// already verified positive evidence until its durable cursor is advanced,
		// but discard every unauthenticated/pass-local assertion.
		this._historyReplayComplete = false;
		this._historyReplayFailed = false;
		this._historySessionHeadId = undefined;
		this._historyReplayTruncated = false;
		this._historyReplayRestartRequested = false;
		this._unpinnedHistoryFrames = [];
		this._unpinnedHistoryBytes = 0;
		this._lastHistorySequence = undefined;
		this._historyPartyIdentityVerified = false;
		this._verifiedHistorySnapshot = undefined;
		if (this._unsupportedPersistenceRotationError) {
			this._historyReplayFailed = true;
			this._historyReplayError = this._unsupportedPersistenceRotationError;
		}
	}

	private maybeRestartTruncatedHistoryReplay(): void {
		if (
			!this._historyReplayTruncated ||
			!this._historyPartyIdentityVerified ||
			this._unreconciledConfirmedTransactions.size > 0 ||
			this._historyReplayRestartRequested
		) {
			return;
		}
		this._historyReplayRestartRequested = true;
		this._historyConnection.invalidate(
			new HydraTransportError('Hydra bounded history page was durably reconciled; restarting replay'),
		);
	}

	private processHistoryMessage(rawMessage: string): void {
		if (this._historyReplayFailed || this._unsupportedPersistenceRotationError) return;
		if (this._expectedHeadId == null) {
			this.bufferUnpinnedHistoryFrame(rawMessage);
			return;
		}
		this.processPinnedHistoryMessage(rawMessage);
	}

	private bufferUnpinnedHistoryFrame(rawMessage: string): void {
		const frameBytes = Buffer.byteLength(rawMessage, 'utf8');
		if (
			frameBytes > MAX_HYDRA_WS_FRAME_BYTES ||
			this._unpinnedHistoryBytes + frameBytes > HydraNode.MAX_UNPINNED_HISTORY_BUFFER_BYTES
		) {
			this.failHistoryReplay(
				new HydraProtocolError('Hydra history exceeded the bounded buffer before its head id was pinned'),
			);
			return;
		}
		this._unpinnedHistoryFrames.push(rawMessage);
		this._unpinnedHistoryBytes += frameBytes;
	}

	private processBufferedUnpinnedHistoryFrames(): void {
		if (this._expectedHeadId == null || this._unpinnedHistoryFrames.length === 0) return;
		const bufferedFrames = this._unpinnedHistoryFrames;
		this._unpinnedHistoryFrames = [];
		this._unpinnedHistoryBytes = 0;
		for (const frame of bufferedFrames) {
			if (this._historyReplayFailed) break;
			this.processPinnedHistoryMessage(frame);
		}
	}

	private processPinnedHistoryMessage(rawMessage: string): void {
		try {
			const message = parseBoundedJsonFrame(rawMessage);
			this.assertPersistenceReplayIsSupported(message);
			const parsedEnvelope = messageSchema.parse(message);
			this.assertExpectedHeadId(parsedEnvelope);
			const suppliedHeadId = assertExpectedFrameHeadId(parsedEnvelope, this._expectedHeadId);
			if (
				parsedEnvelope.tag === 'HeadIsInitializing' ||
				(parsedEnvelope.tag === 'HeadIsOpen' && typeof message === 'object' && message !== null && 'parties' in message)
			) {
				this.bindSnapshotPartyOrder(message);
			}
			if (
				parsedEnvelope.tag === 'HeadIsOpen' &&
				this._trustLocalNodeSnapshotMetadata &&
				typeof message === 'object' &&
				message !== null &&
				'utxo' in message
			) {
				this.recordHistoryOpenAnchor(historyHeadIsOpenMessageSchema.parse(message));
			}
			if (
				parsedEnvelope.tag === 'HeadIsFinalized' &&
				typeof message === 'object' &&
				message !== null &&
				'utxo' in message
			) {
				this.recordFinalizedFanout(headIsFinalizedMessageSchema.parse(message));
			}

			if (parsedEnvelope.tag === 'SnapshotConfirmed') {
				const parsedMessage = historySnapshotConfirmedMessageSchema.parse(message);
				this.assertExpectedHeadId(parsedMessage);
				// Signed states and transaction transitions are verified progressively.
				// This avoids retaining the unbounded raw prefix emitted before Greetings.
				this.recordHistorySnapshot(parsedMessage);
				return;
			}

			if (parsedEnvelope.tag === 'Greetings') {
				this.verifyGreetingsPartyIdentity(message);
				const parsedHeadStatus = hydraHeadStatusSchema.safeParse(parsedEnvelope.headStatus);
				if (!parsedHeadStatus.success) {
					throw new HydraProtocolError('History Greetings frame has an invalid headStatus');
				}
				if ((this._expectedHeadId || this._verifiedHistorySnapshot) && !suppliedHeadId) {
					throw new HydraProtocolError('Pinned Hydra history Greetings omitted its head identifier');
				}
				if (this._verifiedHistorySnapshot && suppliedHeadId !== this._verifiedHistorySnapshot.headId) {
					throw new HydraProtocolError('Hydra history Greetings did not identify the signed snapshot head');
				}
				if (HISTORY_STATUS_REQUIRING_STATE_ANCHOR.has(parsedHeadStatus.data) && this._verifiedHistorySnapshot == null) {
					throw new HydraProtocolError(
						'Hydra history ended without an authenticated Open or signed snapshot state anchor',
					);
				}
				if (suppliedHeadId) this._historySessionHeadId = suppliedHeadId;
				this._historyPartyIdentityVerified = true;
				// Greetings authenticates the end marker, not the preceding transaction
				// metadata. A truncated page remains fail-closed until every retained
				// item has a durable cursor and a later full pass reaches this marker.
				this._historyReplayComplete = !this._historyReplayTruncated;
				if (this._historyReplayComplete) {
					this._historyReplayError = undefined;
					this.trimConfirmedTransactionCache();
				} else this.maybeRestartTruncatedHistoryReplay();
			}
		} catch (error) {
			this.failHistoryReplay(error);
		}
	}

	private recordHistoryOpenAnchor(parsedMessage: ReturnType<typeof historyHeadIsOpenMessageSchema.parse>): void {
		if (this._verifiedHistorySnapshot) {
			throw new HydraProtocolError('Hydra history attempted to replace an established signed-state anchor');
		}
		const outputs = new Map<string, string>();
		const outputMultiset = new Map<string, number>();
		for (const [reference, output] of Object.entries(parsedMessage.utxo)) {
			const serializedOutput = serializeHydraSnapshotOutput(output);
			outputs.set(reference.toLowerCase(), serializedOutput);
			outputMultiset.set(serializedOutput, (outputMultiset.get(serializedOutput) ?? 0) + 1);
		}
		this._verifiedHistorySnapshot = {
			headId: parsedMessage.headId,
			number: 0,
			version: 0,
			outputs,
			outputMultiset,
		};
	}

	private recordFinalizedFanout(parsedMessage: ReturnType<typeof headIsFinalizedMessageSchema.parse>): void {
		this.assertExpectedHeadId(parsedMessage);
		const fanoutOutputs = new Map<string, string>();
		for (const [reference, output] of Object.entries(parsedMessage.utxo)) {
			fanoutOutputs.set(reference.toLowerCase(), serializeHydraSnapshotOutput(output));
		}
		if (this._finalizedFanoutOutputs && !stringMapsEqual(this._finalizedFanoutOutputs, fanoutOutputs)) {
			throw new HydraProtocolError('Hydra history equivocated on the finalized L1 fanout output map');
		}
		this._finalizedFanoutOutputs = fanoutOutputs;
	}

	private recordHistorySnapshot(parsedMessage: ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>): void {
		if (this._lastHistorySequence != null && parsedMessage.seq <= this._lastHistorySequence) {
			throw new HydraProtocolError('Hydra history sequence was duplicate or non-monotonic');
		}
		if (!this._orderedSnapshotVerificationKeys) {
			throw new HydraProtocolError('SnapshotConfirmed arrived without an identity-bearing on-chain party order');
		}
		if (this._historySessionHeadId && parsedMessage.headId !== this._historySessionHeadId) {
			throw new HydraProtocolError('SnapshotConfirmed did not belong to the verified Hydra history session');
		}
		const verifiedSnapshot = verifyHydraSnapshot(parsedMessage, this._orderedSnapshotVerificationKeys);
		const previousSnapshot = this._verifiedHistorySnapshot;
		if (previousSnapshot && verifiedSnapshot.number <= previousSnapshot.number) {
			throw new HydraProtocolError('Hydra signed snapshot number replayed or regressed');
		}
		if (previousSnapshot == null) {
			if (verifiedSnapshot.number > 1 || parsedMessage.snapshot.confirmed.length > 0) {
				throw new HydraProtocolError(
					'Hydra history began with transactions or a snapshot gap and no independently verified predecessor',
				);
			}
			this._verifiedHistorySnapshot = verifiedSnapshot;
			this._lastHistorySequence = parsedMessage.seq;
			return;
		}
		if (
			!doesHydraTransactionTransitionReachSnapshot(previousSnapshot, verifiedSnapshot, parsedMessage.snapshot.confirmed)
		) {
			throw new HydraProtocolError('Hydra history contained a non-consecutive or inconsistent signed-state transition');
		}
		this._verifiedHistorySnapshot = verifiedSnapshot;
		this._lastHistorySequence = parsedMessage.seq;
		const protectedProducerTxIds = this.resolveProtectedSnapshotProducerTxIds(verifiedSnapshot);
		// Hydra 2.3 signatures authenticate only the TxOut multiset. Recording
		// tx ids/CBOR therefore additionally relies on this explicitly configured
		// local endpoint and the manager's per-action actor/body checks.
		if (this._trustLocalNodeSnapshotMetadata) {
			this.recordConfirmedTransactions(parsedMessage, this._historyReplayComplete, protectedProducerTxIds);
		}
		this.adoptSnapshotProducerTxIds(verifiedSnapshot, protectedProducerTxIds);
	}

	private resolveProtectedSnapshotProducerTxIds(snapshot: VerifiedHydraSnapshot): Set<string> {
		const frameProducerTxIds = new Set(
			[...snapshot.outputs.keys()].map((reference) => reference.slice(0, reference.indexOf('#')).toLowerCase()),
		);
		const retainedSnapshotNumber = this._currentSnapshotProducerSnapshotNumber;
		if (retainedSnapshotNumber == null || snapshot.number > retainedSnapshotNumber) return frameProducerTxIds;
		if (snapshot.number < retainedSnapshotNumber) return this._currentSnapshotProducerTxIds;
		if (!setsEqual(frameProducerTxIds, this._currentSnapshotProducerTxIds)) {
			throw new HydraProtocolError('Hydra history equivocated on output references for one signed snapshot');
		}
		return this._currentSnapshotProducerTxIds;
	}

	private adoptSnapshotProducerTxIds(snapshot: VerifiedHydraSnapshot, protectedProducerTxIds: Set<string>): void {
		if (
			this._currentSnapshotProducerSnapshotNumber != null &&
			snapshot.number < this._currentSnapshotProducerSnapshotNumber
		) {
			return;
		}
		this._currentSnapshotProducerSnapshotNumber = snapshot.number;
		this._currentSnapshotProducerTxIds = new Set(protectedProducerTxIds);
		for (const txId of this._cursorPrefixProducerTxIds) {
			if (this._currentSnapshotProducerTxIds.has(txId)) continue;
			if (!this._unreconciledConfirmedTransactions.has(txId)) this._confirmedTransactions.delete(txId);
			this._cursorPrefixProducerTxIds.delete(txId);
		}
		this.trimConfirmedTransactionCache();
	}

	private processStatus(rawMessage: string) {
		let envelope: ReturnType<typeof messageSchema.parse>;
		try {
			const message = parseBoundedJsonFrame(rawMessage);
			this.assertPersistenceReplayIsSupported(message);
			envelope = messageSchema.parse(message);
			const suppliedHeadId = assertExpectedFrameHeadId(envelope, this._expectedHeadId);
			if (envelope.tag === 'HeadIsInitializing' || envelope.tag === 'HeadIsOpen') {
				this.bindSnapshotPartyOrder(message);
				if (suppliedHeadId) this._liveSessionHeadId = suppliedHeadId;
			}
			if (envelope.tag === 'Greetings') {
				const isHeadlessIdle =
					this._expectedHeadId != null && suppliedHeadId == null && envelope.headStatus === HydraHeadStatus.Idle;
				if (this._expectedHeadId && !suppliedHeadId && !isHeadlessIdle) {
					throw new HydraProtocolError('Pinned Hydra session Greetings omitted its head identifier');
				}
				if (suppliedHeadId) {
					this._liveSessionHeadId = suppliedHeadId;
				}
				this.verifyGreetingsPartyIdentity(message);
				this._livePartyIdentityVerified = true;
				if (isHeadlessIdle) {
					// An L1 rollback before/through Init legitimately returns hydra-node
					// to Idle, where no head id exists. Party identity still binds this
					// configured endpoint; clear the old session proof before emitting
					// the regression so the manager can durably invalidate routing.
					this._liveSessionHeadId = undefined;
					this._headClock = undefined;
					this._finalizedFanoutOutputs = undefined;
					if (this._status !== HydraHeadStatus.Idle) {
						this._status = HydraHeadStatus.Idle;
						this.emit(HydraNodeEvent.StatusChange, {
							status: HydraHeadStatus.Idle,
							headId: undefined,
							snapshotNumber: undefined,
							contestationDeadline: undefined,
						} satisfies StatusChangeData);
					}
					return;
				}
				if (this.isLiveSessionReady()) this.emit(LIVE_SESSION_READY_EVENT);
			}
			if (envelope.tag === 'HeadIsFinalized' && typeof message === 'object' && message !== null && 'utxo' in message) {
				this.recordFinalizedFanout(headIsFinalizedMessageSchema.parse(message));
			}
		} catch (error) {
			if (error === this._unsupportedPersistenceRotationError) {
				this.failHistoryReplay(error);
			} else if (isConnectionBindingFrame(rawMessage)) {
				const identityError =
					error instanceof Error ? error : new HydraProtocolError('Hydra live session identity validation failed');
				this._liveSessionHeadId = undefined;
				this._livePartyIdentityVerified = false;
				this._headClock = undefined;
				this.emit(LIVE_SESSION_REJECTED_EVENT, identityError);
				this._connection.invalidate(identityError);
			}
			logger.error('[HydraNode] Rejected status frame', { error: protocolErrorToString(error) });
			return;
		}

		if (!this.isLiveSessionReady()) return;
		const changeData = extractStatusChangeData(rawMessage, this._expectedHeadId);
		if (changeData && changeData.status !== HydraHeadStatus.Final) {
			// A history replay can contain a prior Final while the authenticated
			// live Greetings reports a rolled-back/non-Final tip. Never carry the
			// old fanout map into a later finalization attempt.
			this._finalizedFanoutOutputs = undefined;
		}
		if (changeData && changeData.status !== this._status) {
			this._status = changeData.status;
			this.emit(HydraNodeEvent.StatusChange, changeData);
		}
	}

	private recordConfirmedTransactions(
		parsedMessage: ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>,
		emitEvent: boolean,
		protectedProducerTxIds: ReadonlySet<string>,
	): void {
		if (this._historyReplayTruncated) return;
		const parsedTimestampMs = parsedMessage.timestamp ? Date.parse(parsedMessage.timestamp) : Number.NaN;
		const confirmedAtMs = Number.isNaN(parsedTimestampMs) ? null : parsedTimestampMs;
		// Validate the entire signed transition, including the durable prefix. The
		// cursor controls queuing only; it must never turn old malformed CBOR into an
		// unchecked gap in a replay pass.
		const validatedTransactions = parsedMessage.snapshot.confirmed.map((tx, snapshotTransactionIndex) => {
			const parsedTxId = canonicalHydraTransactionIdSchema.safeParse(tx.txId);
			if (!parsedTxId.success) {
				throw new HydraProtocolError('SnapshotConfirmed contained a non-canonical transaction id');
			}
			let computedTxId: string;
			try {
				computedTxId = String(resolveTxHash(tx.cborHex)).toLowerCase();
			} catch (error) {
				throw new HydraProtocolError('SnapshotConfirmed contained invalid transaction CBOR', { cause: error });
			}
			if (computedTxId !== parsedTxId.data) {
				throw new HydraProtocolError('SnapshotConfirmed transaction id does not match its CBOR body');
			}
			const existing =
				this._confirmedTransactions.get(computedTxId) ?? this._unreconciledConfirmedTransactions.get(computedTxId);
			if (existing && existing.cborHex.toLowerCase() !== tx.cborHex.toLowerCase()) {
				throw new HydraProtocolError('SnapshotConfirmed equivocated on the CBOR for one transaction id');
			}
			if (
				existing &&
				(existing.snapshotSequence !== parsedMessage.seq ||
					existing.snapshotTransactionIndex !== snapshotTransactionIndex)
			) {
				throw new HydraProtocolError('SnapshotConfirmed replayed one transaction at a different history position');
			}
			const isAfterCursor =
				this._reconciledHistoryCursor == null ||
				parsedMessage.seq > this._reconciledHistoryCursor.snapshotSequence ||
				(parsedMessage.seq === this._reconciledHistoryCursor.snapshotSequence &&
					snapshotTransactionIndex > this._reconciledHistoryCursor.snapshotTransactionIndex);
			return { tx: { ...tx, txId: computedTxId }, snapshotTransactionIndex, existing, isAfterCursor };
		});
		if (new Set(validatedTransactions.map(({ tx }) => tx.txId)).size !== validatedTransactions.length) {
			throw new HydraProtocolError('SnapshotConfirmed contained duplicate transaction identifiers');
		}

		for (const { tx, snapshotTransactionIndex, existing, isAfterCursor } of validatedTransactions) {
			const isCurrentSnapshotProducer = protectedProducerTxIds.has(tx.txId);
			const shouldRetain = isAfterCursor || isCurrentSnapshotProducer;
			if (!shouldRetain) continue;
			if (existing) {
				if (!isAfterCursor && isCurrentSnapshotProducer) this._cursorPrefixProducerTxIds.add(tx.txId);
				if (isAfterCursor && !this._unreconciledConfirmedTransactions.has(tx.txId)) {
					this._unreconciledConfirmedTransactions.set(tx.txId, existing);
					this._txCircularBuffer.add(tx.txId);
					if (emitEvent) this.emit(HydraNodeEvent.TxConfirmed, tx.txId, existing);
				}
				continue;
			}
			const transactionCborBytes = tx.cborHex.length / 2;
			if (transactionCborBytes > this._maxRetainedTransactionCborBytes) {
				throw new HydraProtocolError('Hydra confirmation transaction exceeded the entire retained-CBOR byte budget');
			}
			if (isAfterCursor && this._unreconciledConfirmedTransactions.size >= this._maxUnreconciledTransactions) {
				this.truncateHistoryReplayPage();
				break;
			}
			this.evictReconciledTransactionsForCborBudget(transactionCborBytes, protectedProducerTxIds);
			if (this.getRetainedTransactionCborBytes() + transactionCborBytes > this._maxRetainedTransactionCborBytes) {
				if (isCurrentSnapshotProducer) {
					throw new HydraProtocolError(
						'Current Hydra snapshot producer evidence exceeded the retained-CBOR byte budget',
					);
				}
				this.truncateHistoryReplayPage();
				break;
			}
			const confirmedTransaction: HydraConfirmedTransaction = {
				...tx,
				metadataSource: 'ConfiguredLocalHydraNode',
				// Only the official top-level timestamp proves confirmation time.
				// Missing/invalid time stays null and makes initial-lock sync retryable.
				confirmedAtMs,
				snapshotSequence: parsedMessage.seq,
				snapshotTransactionIndex,
			};
			this._confirmedTransactions.set(tx.txId, confirmedTransaction);
			if (isAfterCursor) {
				this._txCircularBuffer.add(tx.txId);
				this._unreconciledConfirmedTransactions.set(tx.txId, confirmedTransaction);
			} else this._cursorPrefixProducerTxIds.add(tx.txId);
			if (this._historyReplayComplete) this.trimConfirmedTransactionCache();
			if (isAfterCursor && emitEvent) this.emit(HydraNodeEvent.TxConfirmed, tx.txId, confirmedTransaction);
		}
	}

	private truncateHistoryReplayPage(): void {
		this._historyReplayTruncated = true;
		this._historyReplayComplete = false;
		this.maybeRestartTruncatedHistoryReplay();
	}

	private getRetainedTransactionCborBytes(): number {
		const retainedIds = new Set([
			...this._confirmedTransactions.keys(),
			...this._unreconciledConfirmedTransactions.keys(),
		]);
		let retainedBytes = 0;
		for (const txId of retainedIds) {
			const retained = this._confirmedTransactions.get(txId) ?? this._unreconciledConfirmedTransactions.get(txId);
			retainedBytes += (retained?.cborHex.length ?? 0) / 2;
		}
		return retainedBytes;
	}

	private evictReconciledTransactionsForCborBudget(
		requiredBytes: number,
		protectedProducerTxIds: ReadonlySet<string> = this._currentSnapshotProducerTxIds,
	): void {
		let retainedBytes = this.getRetainedTransactionCborBytes();
		if (retainedBytes + requiredBytes <= this._maxRetainedTransactionCborBytes) return;
		const evictable = [...this._confirmedTransactions.values()]
			.filter(({ txId }) => !this._unreconciledConfirmedTransactions.has(txId) && !protectedProducerTxIds.has(txId))
			.sort(compareConfirmedTransactions);
		for (const transaction of evictable) {
			this._confirmedTransactions.delete(transaction.txId);
			this._cursorPrefixProducerTxIds.delete(transaction.txId);
			retainedBytes -= transaction.cborHex.length / 2;
			if (retainedBytes + requiredBytes <= this._maxRetainedTransactionCborBytes) return;
		}
	}

	private processHeadClock(rawMessage: string) {
		try {
			const parsed = headClockMessageSchema.safeParse(parseBoundedJsonFrame(rawMessage));
			if (!parsed.success) return;
			this.assertExpectedHeadId(parsed.data);
			if (!this.isLiveSessionReady()) return;
			const chainTimeMs = Date.parse(parsed.data.chainTime);
			if (
				!Number.isFinite(chainTimeMs) ||
				chainTimeMs < EARLIEST_PLAUSIBLE_HEAD_CLOCK_MS ||
				chainTimeMs > Date.now() + MAX_HEAD_CLOCK_FUTURE_SKEW_MS
			) {
				return;
			}
			this._headClock = {
				chainTimeMs,
				chainSlot: parsed.data.chainSlot,
				receivedAtMs: Date.now(),
			};
		} catch {
			// non-JSON frames are other consumers' problem; the clock just skips them
		}
	}

	get headClock(): HydraHeadClock | undefined {
		return this._headClock;
	}

	get confirmedTransactionHistoryReady(): boolean {
		return this._unsupportedPersistenceRotationError == null && this._historyReplayComplete;
	}

	/** Both evidence sockets have authenticated the same explicitly pinned head. */
	get hasVerifiedPinnedSessions(): boolean {
		return (
			this._unsupportedPersistenceRotationError == null &&
			this._expectedHeadId != null &&
			this._liveSessionHeadId === this._expectedHeadId &&
			this._historySessionHeadId === this._expectedHeadId &&
			this._configuredPartyKeys.size === 2 &&
			this._expectedNodeVerificationKey != null &&
			this._orderedSnapshotVerificationKeys?.length === 2 &&
			this._livePartyIdentityVerified &&
			this._historyPartyIdentityVerified &&
			this._verifiedHistorySnapshot?.headId === this._expectedHeadId &&
			this._historyReplayComplete
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
		if (
			!this.hasVerifiedPinnedSessions ||
			this._status !== HydraHeadStatus.Final ||
			!Number.isSafeInteger(expectedSnapshotNumber) ||
			expectedSnapshotNumber < 0 ||
			this._verifiedHistorySnapshot?.number !== expectedSnapshotNumber ||
			this._finalizedFanoutOutputs == null
		) {
			return null;
		}
		const separator = hydraReference.indexOf('#');
		if (separator <= 0 || hydraReference.indexOf('#', separator + 1) !== -1) return null;
		const producerTxHash = hydraReference.slice(0, separator).toLowerCase();
		const outputIndexText = hydraReference.slice(separator + 1);
		if (!/^[0-9a-f]{64}$/.test(producerTxHash) || !/^(?:0|[1-9][0-9]*)$/.test(outputIndexText)) return null;
		const outputIndex = Number(outputIndexText);
		if (!Number.isSafeInteger(outputIndex) || outputIndex < 0 || outputIndex > 0xffffffff) return null;
		const confirmedProducer = this.getConfirmedTransaction(producerTxHash);
		if (!confirmedProducer) return null;
		let serializedOutput: string;
		try {
			const transaction = FixedTransaction.from_bytes(Buffer.from(confirmedProducer.cborHex, 'hex'));
			if (!transaction.is_valid() || transaction.transaction_hash().to_hex().toLowerCase() !== producerTxHash) {
				return null;
			}
			const outputs = transaction.body().outputs();
			if (outputIndex >= outputs.len()) return null;
			serializedOutput = serializeCardanoTransactionOutput(outputs.get(outputIndex));
		} catch {
			return null;
		}
		return resolveVerifiedHydraFanoutReference(
			this._verifiedHistorySnapshot,
			this._finalizedFanoutOutputs,
			serializedOutput,
		);
	}

	getVerifiedFanoutReferences(expectedSnapshotNumber: number): VerifiedHydraFanoutReference[] | null {
		if (
			!this.hasVerifiedPinnedSessions ||
			this._status !== HydraHeadStatus.Final ||
			!Number.isSafeInteger(expectedSnapshotNumber) ||
			expectedSnapshotNumber < 0 ||
			this._verifiedHistorySnapshot?.number !== expectedSnapshotNumber ||
			this._finalizedFanoutOutputs == null
		) {
			return null;
		}
		return resolveVerifiedHydraFanoutReferences(this._verifiedHistorySnapshot, this._finalizedFanoutOutputs);
	}

	get confirmedTransactionHistoryError(): Error | undefined {
		return this._unsupportedPersistenceRotationError ?? this._historyReplayError;
	}

	private sendCommandAndWait(options: {
		command: string;
		payload: unknown;
		timeoutMs: number;
		transactionHash?: string;
		isComplete: (message: HydraResponseMessage) => boolean;
		timeoutMessage: string;
		retryIntervalMs?: number;
	}): Promise<void> {
		if (this._unsupportedPersistenceRotationError) {
			return Promise.reject(this._unsupportedPersistenceRotationError);
		}
		if (!this.isLiveSessionReady()) {
			return Promise.reject(new HydraTransportError('Hydra live session identity has not been verified'));
		}
		const { command, payload, timeoutMs, transactionHash, isComplete, timeoutMessage, retryIntervalMs } = options;
		return new Promise<void>((resolve, reject) => {
			let isSettled = false;
			let wasQueued = false;
			let retryInterval: ReturnType<typeof setInterval> | undefined;

			const cleanup = () => {
				clearTimeout(timeout);
				if (retryInterval) clearInterval(retryInterval);
				this._connection.removeListener('message', handleMessage);
				this._connection.removeListener('close', handleClose);
			};
			const settleResolve = () => {
				if (isSettled) return;
				isSettled = true;
				cleanup();
				resolve();
			};
			const settleReject = (error: unknown) => {
				if (isSettled) return;
				isSettled = true;
				cleanup();
				reject(error);
			};
			const ambiguousError = (message: string, cause?: unknown) =>
				new HydraTransportAmbiguousError(message, cause === undefined ? undefined : { cause });
			const handleMessage = (data: string) => {
				const outcome = handleWsResponse(data, command, transactionHash, this._expectedHeadId);
				if (outcome.kind === 'ignore') return;
				if (outcome.kind === 'protocol-error') {
					settleReject(
						wasQueued
							? ambiguousError(`Hydra ${command} outcome is ambiguous after a malformed response`, outcome.error)
							: outcome.error,
					);
					return;
				}
				if (outcome.kind === 'reject') {
					settleReject(
						command === 'Close' && wasQueued
							? ambiguousError(
									'Hydra Close was rejected after dispatch; the head may already have closed',
									outcome.error,
								)
							: outcome.error,
					);
					return;
				}
				if (isComplete(outcome.message)) settleResolve();
			};
			const handleClose = (reason: unknown) => {
				// Let Connection.send's promise settle first when the close happened
				// while it was still waiting for OPEN. Once bytes were queued, loss of
				// the response is explicitly ambiguous.
				queueMicrotask(() => {
					if (isSettled) return;
					settleReject(
						wasQueued
							? ambiguousError(`Hydra ${command} outcome is ambiguous after transport closure`, reason)
							: new HydraTransportError(`Hydra ${command} was not sent before transport closure`, {
									cause: reason,
								}),
					);
				});
			};
			const send = () => {
				void this._connection
					.send(payload)
					.then(() => {
						wasQueued = true;
					})
					.catch((error: unknown) => {
						if (!wasQueued) settleReject(error);
					});
			};

			this._connection.on('message', handleMessage);
			this._connection.on('close', handleClose);
			const timeout = setTimeout(() => {
				settleReject(
					wasQueued
						? ambiguousError(timeoutMessage)
						: new HydraTransportError(`${command} was not sent before its ${timeoutMs}ms deadline`),
				);
			}, timeoutMs);
			send();
			if (retryIntervalMs) retryInterval = setInterval(send, retryIntervalMs);
		});
	}

	async init(timeoutMs: number = HydraNode.INIT_OBSERVE_TIMEOUT_MS) {
		// The head may already be initializing or open (e.g. on reconnect, or
		// when hydra-node transitions past Initializing before we observe it).
		// The node may compact old lifecycle messages even when transaction
		// history replay is enabled, so guard against waiting for a transition
		// that has already passed.
		if (this._status === HydraHeadStatus.Initializing || this._status === HydraHeadStatus.Open) {
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
		const hydraUTxOs = utxos.reduce(
			(acc, utxo) => {
				acc[`${utxo.input.txHash}#${utxo.input.outputIndex}`] = mapUTxOToHydraUTxO(utxo);
				return acc;
			},
			{} as Record<string, HydraUTxO>,
		);

		let bodyRequest;
		if (blueprintTx) {
			bodyRequest = {
				blueprintTx,
				utxo: hydraUTxOs,
			};
		} else {
			bodyRequest = hydraUTxOs;
		}

		const response = await this.post<HydraTransaction>('/commit', bodyRequest);
		return response;
	}

	async cardanoTransaction(transaction: HydraTransaction) {
		const response = await this.post('/cardano-transaction', transaction);
		return response;
	}

	async snapshotUTxO(): Promise<UTxO[]> {
		const response = hydraSnapshotUtxoSchema.safeParse(await this.get('/snapshot/utxo'));
		if (!response.success) {
			throw new HydraProtocolError('Hydra snapshot UTxO response failed schema validation', {
				cause: response.error,
			});
		}
		const utxos = Object.keys(response.data).map((txId: string) =>
			mapHydraUTxOToUTxO(txId, response.data[txId] as HydraUTxO),
		);
		return utxos;
	}

	async fetchProtocolParameters() {
		const response = hydraProtocolParametersSchema.safeParse(await this.get('/protocol-parameters'));
		if (!response.success) {
			throw new HydraProtocolError('Hydra protocol parameters failed schema validation', { cause: response.error });
		}
		const rawParameters = response.data;

		const parameters: Protocol = castProtocol({
			coinsPerUtxoSize: rawParameters.utxoCostPerByte,
			collateralPercent: rawParameters.collateralPercentage,
			maxBlockExMem: String(rawParameters.maxBlockExecutionUnits.memory),
			maxBlockExSteps: String(rawParameters.maxBlockExecutionUnits.steps),
			maxBlockHeaderSize: rawParameters.maxBlockHeaderSize,
			maxBlockSize: rawParameters.maxBlockBodySize,
			maxCollateralInputs: rawParameters.maxCollateralInputs,
			maxTxExMem: String(rawParameters.maxTxExecutionUnits.memory),
			maxTxExSteps: String(rawParameters.maxTxExecutionUnits.steps),
			maxTxSize: rawParameters.maxTxSize,
			maxValSize: rawParameters.maxValueSize,
			minFeeA: rawParameters.txFeePerByte,
			minFeeB: rawParameters.txFeeFixed,
			minPoolCost: String(rawParameters.minPoolCost),
			poolDeposit: rawParameters.stakePoolDeposit,
			priceMem: rawParameters.executionUnitPrices.priceMemory,
			priceStep: rawParameters.executionUnitPrices.priceSteps,
		});

		return parameters;
	}

	async fetchRawCostModels(): Promise<HydraRawCostModels> {
		// `/protocol-parameters` returns the Cardano-API ProtocolParameters JSON
		// the head was configured with; its `costModels` field carries the exact
		// per-language arrays the head's ledger hashes into the script-data-hash.
		// castProtocol() (used by fetchProtocolParameters above) drops these, so
		// fetch the raw payload and extract them here.
		const response = hydraCostModelsEnvelopeSchema.safeParse(await this.get('/protocol-parameters'));
		if (!response.success) {
			throw new HydraProtocolError('Hydra cost-model response failed schema validation', { cause: response.error });
		}
		const costModels = response.data.costModels;
		const parseCostModel = (language: string, value: unknown): number[] | undefined => {
			if (value === undefined) return undefined;
			const parsedCostModel = hydraCostModelSchema.safeParse(value);
			if (!parsedCostModel.success) {
				throw new HydraProtocolError(`Hydra ${language} cost model failed schema validation`, {
					cause: parsedCostModel.error,
				});
			}
			return parsedCostModel.data;
		};
		return {
			PlutusV1: parseCostModel('PlutusV1', costModels?.PlutusV1),
			PlutusV2: parseCostModel('PlutusV2', costModels?.PlutusV2),
			PlutusV3: parseCostModel('PlutusV3', costModels?.PlutusV3),
		};
	}

	async newTx(transaction: HydraTransaction) {
		const parsedTransaction = hydraCommandTransactionSchema.safeParse(transaction);
		if (!parsedTransaction.success) {
			throw new HydraProtocolError('Cannot submit a transaction that violates the bounded Hydra schema', {
				cause: parsedTransaction.error,
			});
		}
		let txHash: string;
		try {
			txHash = String(resolveTxHash(parsedTransaction.data.cborHex)).toLowerCase();
		} catch (error) {
			throw new HydraProtocolError('Cannot submit invalid transaction CBOR to Hydra', { cause: error });
		}
		const suppliedTxId =
			parsedTransaction.data.txId == null
				? undefined
				: canonicalHydraTransactionIdSchema.safeParse(parsedTransaction.data.txId);
		if (suppliedTxId && (!suppliedTxId.success || suppliedTxId.data !== txHash)) {
			throw new HydraProtocolError('Cannot submit a transaction whose txId does not match its CBOR body');
		}
		const commandTransaction = {
			...parsedTransaction.data,
			...(suppliedTxId?.success ? { txId: suppliedTxId.data } : {}),
		};
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
		return this._txCircularBuffer.getBuffer().includes(txHash);
	}

	getConfirmedTransaction(txHash: string): HydraConfirmedTransaction | null {
		return this._confirmedTransactions.get(txHash) ?? this._unreconciledConfirmedTransactions.get(txHash) ?? null;
	}

	getConfirmedTransactions(): HydraConfirmedTransaction[] {
		return this._unsupportedPersistenceRotationError == null && this._historyReplayComplete
			? [...this._confirmedTransactions.values()].sort(compareConfirmedTransactions)
			: [];
	}

	getConfirmedTransactionsForReconciliation(): HydraConfirmedTransaction[] {
		// Every queued item already passed configured-party signatures, full-state
		// accumulator verification, and a consecutive signed-state transition. It is
		// safe to durably drain a bounded page before the terminal Greetings marker;
		// destructive/live-tip inference remains separately gated on a complete pass.
		if (this._expectedHeadId == null || this._unsupportedPersistenceRotationError) return [];
		return [...this._unreconciledConfirmedTransactions.values()].sort(compareConfirmedTransactions);
	}

	markConfirmedTransactionReconciled(txHash: string): void {
		const ordered = [...this._unreconciledConfirmedTransactions.values()].sort(compareConfirmedTransactions);
		const first = ordered[0];
		if (!first) return;
		if (first.txId !== txHash) {
			throw new HydraProtocolError('Hydra confirmed transactions must be reconciled in history order');
		}
		if (first.snapshotSequence == null) {
			throw new HydraProtocolError('Hydra history evidence cannot advance a cursor without a sequence');
		}
		const nextCursor = {
			snapshotSequence: first.snapshotSequence,
			snapshotTransactionIndex: first.snapshotTransactionIndex,
		};
		if (
			this._reconciledHistoryCursor &&
			(nextCursor.snapshotSequence < this._reconciledHistoryCursor.snapshotSequence ||
				(nextCursor.snapshotSequence === this._reconciledHistoryCursor.snapshotSequence &&
					nextCursor.snapshotTransactionIndex <= this._reconciledHistoryCursor.snapshotTransactionIndex))
		) {
			throw new HydraProtocolError('Hydra reconciliation cursor did not advance monotonically');
		}
		this._reconciledHistoryCursor = nextCursor;
		this._unreconciledConfirmedTransactions.delete(txHash);
		if (this._currentSnapshotProducerTxIds.has(txHash)) this._cursorPrefixProducerTxIds.add(txHash);
		this.trimConfirmedTransactionCache();
		this.maybeRestartTruncatedHistoryReplay();
	}

	private trimConfirmedTransactionCache(): void {
		const excess = this._confirmedTransactions.size - 10_000;
		if (excess <= 0) return;
		const oldest = [...this._confirmedTransactions.values()]
			.filter(
				({ txId }) =>
					!this._unreconciledConfirmedTransactions.has(txId) && !this._currentSnapshotProducerTxIds.has(txId),
			)
			.sort(compareConfirmedTransactions)
			.slice(0, excess);
		for (const transaction of oldest) {
			this._confirmedTransactions.delete(transaction.txId);
			this._cursorPrefixProducerTxIds.delete(transaction.txId);
		}
	}

	async disconnect(): Promise<void> {
		await Promise.all([this._connection.disconnect(), this._historyConnection.disconnect()]);
		this._status = HydraHeadStatus.Disconnected;
		this._liveSessionHeadId = undefined;
		this._livePartyIdentityVerified = false;
		this._headClock = undefined;
		this.resetHistoryReplayPass();
		this._confirmedTransactions.clear();
		this._unreconciledConfirmedTransactions.clear();
		this._txCircularBuffer.clear();
		this._currentSnapshotProducerTxIds.clear();
		this._currentSnapshotProducerSnapshotNumber = undefined;
		this._cursorPrefixProducerTxIds.clear();
		this._finalizedFanoutOutputs = undefined;
		this._historyReplayError = this._unsupportedPersistenceRotationError;
		this._connectionsStarted = false;
	}

	async awaitTx(txHash: string, checkInterval: number = 1000) {
		if (!Number.isSafeInteger(checkInterval) || checkInterval <= 0) {
			throw new HydraProtocolError('Hydra confirmation polling interval must be a positive safe integer');
		}
		if (this._txCircularBuffer.getBuffer().includes(txHash)) return true;
		return new Promise<boolean>((resolve, reject) => {
			const cleanup = () => {
				clearInterval(interval);
				clearTimeout(timeout);
				this._connection.removeListener('close', handleClose);
				this._historyConnection.removeListener('close', handleClose);
			};
			const handleClose = (reason: unknown) => {
				cleanup();
				if (this._txCircularBuffer.getBuffer().includes(txHash)) {
					resolve(true);
					return;
				}
				reject(
					new HydraTransportAmbiguousError(`Hydra confirmation for ${txHash} is unknown after transport closure`, {
						cause: reason,
					}),
				);
			};
			const interval = setInterval(() => {
				if (this._txCircularBuffer.getBuffer().includes(txHash)) {
					cleanup();
					resolve(true);
				}
			}, checkInterval);
			const timeout = setTimeout(() => {
				cleanup();
				reject(
					new HydraTransportAmbiguousError(
						`Hydra transaction ${txHash} was not confirmed within ${this._commandTimeoutMs}ms`,
					),
				);
			}, this._commandTimeoutMs);
			this._connection.on('close', handleClose);
			this._historyConnection.on('close', handleClose);
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
		return await this.requestHttp<T>('GET', url);
	}

	async post<T = unknown>(url: string, payload: unknown): Promise<T> {
		return await this.requestHttp<T>('POST', url, payload);
	}

	private async requestHttp<T>(method: 'GET' | 'POST', url: string, payload?: unknown): Promise<T> {
		if (this._unsupportedPersistenceRotationError) throw this._unsupportedPersistenceRotationError;
		let serializedPayload: string | undefined;
		if (method === 'POST') {
			try {
				serializedPayload = stringifyHydraJson(payload);
			} catch (error) {
				throw new HydraProtocolError('Hydra HTTP request payload could not be serialized', { cause: error });
			}
			if (Buffer.byteLength(serializedPayload, 'utf8') > MAX_HYDRA_WS_FRAME_BYTES) {
				throw new HydraProtocolError('Hydra HTTP request payload exceeded its byte limit');
			}
		}

		const abortController = new AbortController();
		let didTimeout = false;
		const timeout = setTimeout(() => {
			didTimeout = true;
			abortController.abort();
		}, this._httpTimeoutMs);
		timeout.unref?.();
		try {
			const response = await fetch(this._httpUrl + url, {
				method,
				headers: { 'Content-Type': 'application/json' },
				redirect: 'error',
				signal: abortController.signal,
				...(serializedPayload === undefined ? {} : { body: serializedPayload }),
			});
			try {
				return (await handleHttpResponse(response)) as T;
			} catch (error) {
				if (error instanceof HydraHttpResponseError) {
					if (method === 'GET' || error.status < 500) throw error;
					throw new HydraTransportAmbiguousError(
						`Hydra HTTP POST outcome is ambiguous after a ${error.status} response`,
						{ cause: error },
					);
				}
				if (method === 'GET') throw error;
				throw new HydraTransportAmbiguousError(
					'Hydra HTTP POST outcome is ambiguous because its response could not be authenticated',
					{ cause: error },
				);
			}
		} catch (error) {
			if (
				error instanceof HydraHttpResponseError ||
				error instanceof HydraTransportAmbiguousError ||
				error instanceof HydraProtocolError
			) {
				throw error;
			}
			if (method === 'POST') {
				throw new HydraTransportAmbiguousError(
					didTimeout
						? `Hydra HTTP POST outcome is ambiguous after a ${this._httpTimeoutMs}ms timeout`
						: 'Hydra HTTP POST outcome is ambiguous after a transport failure',
					{ cause: error },
				);
			}
			throw new HydraTransportError(
				didTimeout
					? `Hydra HTTP GET timed out after ${this._httpTimeoutMs}ms`
					: 'Hydra HTTP GET failed before a response was received',
				{ cause: error },
			);
		} finally {
			clearTimeout(timeout);
		}
	}

	get status() {
		return this._status;
	}

	get httpUrl() {
		return this._httpUrl;
	}

	get wsUrl() {
		return this._wsUrl;
	}
}

class CircularBuffer<T> {
	private buffer: T[];
	private length: number;
	private pointer: number;

	constructor(length: number) {
		this.buffer = new Array(length);
		this.length = length;
		this.pointer = 0;
	}

	add(element: T) {
		this.buffer[(this.pointer = (this.pointer + 1) % this.length)] = element;
	}
	getBuffer() {
		return this.buffer;
	}
	clear() {
		this.buffer = new Array(this.length);
		this.pointer = 0;
	}
}

class HydraHttpResponseError extends Error {
	override readonly name = 'HydraHttpResponseError';

	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function handleHttpResponse(response: Response): Promise<unknown> {
	const responseText = await readBoundedHttpResponse(response);
	let responseBody: unknown;
	try {
		responseBody = parseHydraJson(responseText);
	} catch (error) {
		if (response.ok === false) throw createHttpResponseError(response);
		throw new HydraProtocolError('Hydra HTTP response was not valid JSON', { cause: error });
	}
	if (response.ok === false) throw createHttpResponseError(response);
	return responseBody;
}

async function readBoundedHttpResponse(response: Response): Promise<string> {
	if (response.body && typeof response.body.getReader === 'function') {
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let totalBytes = 0;
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_HYDRA_HTTP_RESPONSE_BYTES) {
				await reader.cancel();
				throw new HydraProtocolError('Hydra HTTP response exceeded its byte limit');
			}
			chunks.push(chunk.value);
		}
		return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
	}

	let responseText: string;
	if (typeof response.text === 'function') {
		responseText = await response.text();
	} else if (typeof response.json === 'function') {
		try {
			responseText = stringifyHydraJson(await response.json());
		} catch (error) {
			throw new HydraProtocolError('Hydra HTTP response contained an inexact JSON number', { cause: error });
		}
	} else {
		throw new HydraProtocolError('Hydra HTTP response body was unavailable');
	}
	if (Buffer.byteLength(responseText, 'utf8') > MAX_HYDRA_HTTP_RESPONSE_BYTES) {
		throw new HydraProtocolError('Hydra HTTP response exceeded its byte limit');
	}
	return responseText;
}

function createHttpResponseError(response: Response): Error {
	const status = [response.status, response.statusText].filter(Boolean).join(' ');
	const statusSuffix = status ? ` with ${status}` : '';
	return new HydraHttpResponseError(`Hydra HTTP request failed${statusSuffix}`, response.status);
}

type WsResponseOutcome =
	| { kind: 'message'; message: HydraResponseMessage }
	| { kind: 'reject'; error: Error }
	| { kind: 'protocol-error'; error: HydraProtocolError }
	| { kind: 'ignore' };

type HydraResponseMessage = {
	tag: string;
	transactionId?: string;
	headStatus?: string;
};

function parseBoundedJsonFrame(rawMessage: string): unknown {
	if (typeof rawMessage !== 'string') {
		throw new HydraProtocolError('Hydra websocket frame was not text');
	}
	if (Buffer.byteLength(rawMessage, 'utf8') > MAX_HYDRA_WS_FRAME_BYTES) {
		throw new HydraProtocolError(`Hydra websocket frame exceeded ${MAX_HYDRA_WS_FRAME_BYTES} bytes`);
	}
	try {
		return parseHydraJson(rawMessage);
	} catch (error) {
		throw new HydraProtocolError('Hydra websocket frame was not valid JSON', { cause: error });
	}
}

function protocolErrorToString(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 512);
	return 'Non-error protocol failure';
}

function isEventLogRotatedFrame(value: unknown): boolean {
	return typeof value === 'object' && value !== null && 'tag' in value && value.tag === 'EventLogRotated';
}

function createUnsupportedPersistenceRotationError(): HydraProtocolError {
	return new HydraProtocolError(UNSUPPORTED_PERSISTENCE_ROTATION_MESSAGE);
}

function isHeadScopedServerOutputTag(tag: unknown): tag is string {
	return typeof tag === 'string' && HEAD_SCOPED_SERVER_OUTPUT_TAGS.has(tag);
}

function frameRequiresHeadId(message: { tag?: string; headStatus?: string }): boolean {
	return (
		isHeadScopedServerOutputTag(message.tag) ||
		(message.tag === 'Greetings' && message.headStatus != null && message.headStatus !== HydraHeadStatus.Idle)
	);
}

function isConnectionBindingFrame(rawMessage: string): boolean {
	try {
		const value = parseBoundedJsonFrame(rawMessage);
		if (typeof value !== 'object' || value === null) return false;
		return (
			'tag' in value &&
			(value.tag === 'Greetings' ||
				value.tag === 'EventLogRotated' ||
				isHeadScopedServerOutputTag(value.tag) ||
				'headId' in value ||
				'hydraHeadId' in value)
		);
	} catch {
		return false;
	}
}

function assertExpectedFrameHeadId(
	message: { tag?: string; headStatus?: string; headId?: string; hydraHeadId?: string | null },
	expectedHeadId?: string,
): string | undefined {
	const suppliedIds = [message.headId, message.hydraHeadId]
		.filter((value): value is string => value != null)
		.map((value) => {
			const parsedHeadId = canonicalHydraHeadIdSchema.safeParse(value);
			if (!parsedHeadId.success) {
				throw new HydraProtocolError('Hydra frame contained a non-canonical head identifier');
			}
			return parsedHeadId.data;
		});
	if (new Set(suppliedIds).size > 1) {
		throw new HydraProtocolError('Hydra frame contained conflicting head identifiers');
	}
	if (frameRequiresHeadId(message) && suppliedIds.length === 0) {
		throw new HydraProtocolError(`Hydra ${message.tag ?? 'head-scoped'} frame omitted its head identifier`);
	}
	if (expectedHeadId && suppliedIds[0] && suppliedIds[0] !== expectedHeadId) {
		throw new HydraProtocolError(`Hydra frame head id did not match the pinned head`);
	}
	return suppliedIds[0];
}

function setsEqual(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
	return left.size === right.size && [...left].every((value) => right.has(value));
}

function stringMapsEqual(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>): boolean {
	return left.size === right.size && [...left].every(([key, value]) => right.get(key) === value);
}

function resolveBoundTransactionHash(transaction: { txId: string; cborHex: string }): string {
	const parsedTxId = canonicalHydraTransactionIdSchema.safeParse(transaction.txId);
	if (!parsedTxId.success) throw new HydraProtocolError('Hydra response contained a non-canonical transaction id');
	let computedTxId: string;
	try {
		computedTxId = String(resolveTxHash(transaction.cborHex)).toLowerCase();
	} catch (error) {
		throw new HydraProtocolError('Hydra response contained invalid transaction CBOR', { cause: error });
	}
	if (computedTxId !== parsedTxId.data) {
		throw new HydraProtocolError('Hydra response transaction id did not match its CBOR body');
	}
	return computedTxId;
}

function resolveCommandTransactionHash(transaction: { txId?: string; cborHex: string }): string {
	let computedTxId: string;
	try {
		computedTxId = String(resolveTxHash(transaction.cborHex)).toLowerCase();
	} catch (error) {
		throw new HydraProtocolError('CommandFailed echoed invalid transaction CBOR', { cause: error });
	}
	if (transaction.txId != null) {
		const parsedTxId = canonicalHydraTransactionIdSchema.safeParse(transaction.txId);
		if (!parsedTxId.success || parsedTxId.data !== computedTxId) {
			throw new HydraProtocolError('CommandFailed echoed inconsistent transaction identity');
		}
	}
	return computedTxId;
}

function handleWsResponse(
	rawMessage: string,
	command: string,
	transactionHash?: string,
	expectedHeadId?: string,
): WsResponseOutcome {
	try {
		const raw = parseBoundedJsonFrame(rawMessage);
		if (isEventLogRotatedFrame(raw)) throw createUnsupportedPersistenceRotationError();
		const envelope = messageSchema.parse(raw);
		assertExpectedFrameHeadId(envelope, expectedHeadId);

		if (envelope.tag === 'TxValid') {
			const message = txValidMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			return { kind: 'message', message };
		}
		if (envelope.tag === 'TxInvalid') {
			const message = txInvalidMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			const rejectedTxHash = resolveBoundTransactionHash(message.transaction);
			if (command === 'NewTx' && transactionHash === rejectedTxHash) {
				return { kind: 'reject', error: new HydraTransactionRejectedError('Transaction is invalid') };
			}
			return { kind: 'message', message };
		}
		if (envelope.tag === 'CommandFailed') {
			const message = commandFailedMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			if (command === 'NewTx') {
				if (message.clientInput?.tag !== 'NewTx' || !message.clientInput.transaction || !transactionHash) {
					return { kind: 'ignore' };
				}
				const rejectedTxHash = resolveCommandTransactionHash(message.clientInput.transaction);
				if (rejectedTxHash !== transactionHash) return { kind: 'ignore' };
				return {
					kind: 'reject',
					error: new HydraTransactionRejectedError(`Error posting transaction with hash ${transactionHash}`),
				};
			}
			if (message.clientInput?.tag === command) {
				return { kind: 'reject', error: new HydraCommandRejectedError(`Command ${command} failed`) };
			}
			return { kind: 'message', message };
		}
		if (envelope.tag === 'PostTxOnChainFailed') {
			const message = postTxOnChainFailedMessageSchema.parse(raw);
			assertExpectedFrameHeadId(message, expectedHeadId);
			if (message.postChainTx?.tag === `${command}Tx`) {
				return {
					kind: 'reject',
					error: new HydraCommandRejectedError(
						`Error posting transaction for command ${command}; hydra-node rejected the L1 action`,
					),
				};
			}
			return { kind: 'message', message };
		}

		return { kind: 'message', message: envelope };
	} catch (error) {
		return {
			kind: 'protocol-error',
			error:
				error instanceof HydraProtocolError
					? error
					: new HydraProtocolError('Hydra websocket response failed schema validation', { cause: error }),
		};
	}
}

function extractStatusChangeData(rawMessage: string, expectedHeadId?: string): StatusChangeData | null {
	try {
		const message = parseBoundedJsonFrame(rawMessage);
		const parsedMessage = messageSchema.parse(message);
		const suppliedHeadId = assertExpectedFrameHeadId(parsedMessage, expectedHeadId);
		let newStatus: HydraHeadStatus | null = null;
		switch (parsedMessage.tag) {
			case 'Greetings':
				newStatus = hydraHeadStatusSchema.safeParse(parsedMessage.headStatus).data ?? null;
				break;
			case 'HeadIsInitializing':
				newStatus = HydraHeadStatus.Initializing;
				break;
			case 'HeadIsOpen':
				newStatus = HydraHeadStatus.Open;
				break;
			case 'HeadIsClosed':
				newStatus = HydraHeadStatus.Closed;
				break;
			case 'ReadyToFanout':
				newStatus = HydraHeadStatus.FanoutPossible;
				break;
			case 'HeadIsFinalized':
				newStatus = HydraHeadStatus.Final;
				break;
			default:
				newStatus = hydraHeadStatusSchema.safeParse(parsedMessage.headStatus).data ?? null;
				break;
		}

		if (!newStatus) return null;

		return {
			status: newStatus,
			headId: suppliedHeadId,
			snapshotNumber: parsedMessage.snapshotNumber,
			contestationDeadline: parsedMessage.contestationDeadline,
		};
	} catch (error) {
		logger.error('[HydraNode] Rejected status frame', { error: protocolErrorToString(error) });
		return null;
	}
}
