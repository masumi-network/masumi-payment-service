/**
 * The live session's state machine: what this process believes about one head
 * *right now*, folded from the live socket's frames — head status, session
 * identity, the head clock, pending deposit fold-ins, and the outcomes held
 * back until identity is proven.
 *
 * The mirror of `HydraHistoryReplay`, for the live socket. Everything here is
 * per-session and re-derived on reconnect; identity is never assumed, only
 * proven by a Greetings that names the configured keys and pinned head. A
 * finalized head's node greets Idle and names no head; there the replayed
 * history proves the head.
 */

import { EventEmitter } from 'node:events';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraProtocolError, HydraTransportError } from './errors';
import { type HydraHeadClock } from './node-api';
import {
	assertExpectedFrameHeadId,
	extractStatusChangeData,
	isConnectionBindingFrame,
	parseBoundedJsonFrame,
	protocolErrorToString,
	readDecommitSettled,
	readDepositRecorded,
	readPostTxFailed,
} from './node-frames';
import { HeldBackEmissions } from './node-held-back';
import { hasFinalizedUtxoField, headClockMessageSchema, messageSchema } from './schemas';
import { DecommitSettledData, DepositRecordedData, HydraNodeEvent, PostTxFailedData, StatusChangeData } from './types';

/** Connect may return. Also emitted for a held headless Idle, which is not live-ready. */
export const LIVE_SESSION_READY_EVENT = 'hydraLiveSessionReady';
export const LIVE_SESSION_REJECTED_EVENT = 'hydraLiveSessionRejected';

/**
 * Resolve once `emitter` reports that connect may return, reject on its
 * rejection or after `timeoutMs`. Resolves at once if `isReady()` already holds.
 */
export function waitForLiveSessionReady(
	emitter: EventEmitter,
	isReady: () => boolean,
	timeoutMs: number,
): Promise<void> {
	if (isReady()) return Promise.resolve();

	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timeout);
			emitter.removeListener(LIVE_SESSION_READY_EVENT, handleReady);
			emitter.removeListener(LIVE_SESSION_REJECTED_EVENT, handleRejected);
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
					`Hydra websocket did not provide a matching identity-bearing Greetings within ${timeoutMs}ms`,
				),
			);
		}, timeoutMs);
		emitter.on(LIVE_SESSION_READY_EVENT, handleReady);
		emitter.on(LIVE_SESSION_REJECTED_EVENT, handleRejected);
	});
}
const EARLIEST_PLAUSIBLE_HEAD_CLOCK_MS = Date.UTC(2017, 8, 23);
const MAX_HEAD_CLOCK_FUTURE_SKEW_MS = 5 * 60 * 1000;

/** `txHash#index`, the reference form hydra-node keys its UTxO maps by. */
const HYDRA_UTXO_REFERENCE_PATTERN = /^[0-9a-fA-F]{64}#\d{1,5}$/;

/** What live-frame processing needs from the session it serves. */
export interface LiveFrameHost {
	readonly expectedHeadId: string | undefined;
	readonly persistenceRotationError: HydraProtocolError | undefined;
	readonly configuredKeyCount: number;
	/** Throws (and latches) when the frame announces event-log rotation. */
	assertPersistenceReplayIsSupported(message: unknown): void;
	bindSnapshotPartyOrder(message: unknown): void;
	verifyGreetingsPartyIdentity(message: unknown): void;
	/** Record a finalized fanout map, shared with history replay's sightings. */
	recordFinalizedFanout(message: unknown): void;
	/** Never carry an old fanout map past a non-Final tip. */
	clearFinalizedFanout(): void;
	/** The pinned head is proven finalized: its fanout map, and a live Final or a closed pass that finalized it. */
	finalizedHeadProven(): boolean;
	/** The snapshot the proven finalized head settled on, if its replay saw the close. */
	finalizedSnapshotNumber(): number | undefined;
	/** Replay the history again from the start: only a pass that starts now can give a verdict. */
	rereadHistory(): void;
	setNetworkConnected(connected: boolean): void;
	/** The rotation latch was hit on the live socket: fail the replay with it. */
	onRotationError(error: unknown): void;
	invalidateLiveConnection(error: Error): void;
	/** A command waiting on this node posts `postChainTxTag`, so its caller hears of a failure to post it. */
	isAwaitingPostChainTx(postChainTxTag: string): boolean;
}

export class LiveFrameProcessor {
	private _status: HydraHeadStatus = HydraHeadStatus.Disconnected;
	private _liveSessionHeadId: string | undefined;
	private _livePartyIdentityVerified = false;
	/**
	 * A party-verified headless Idle Greetings for the pinned head is held until
	 * the replay says whether that head was finalized. hydra-node is Idle after a
	 * fanout and after a rollback through Init, and only the history tells them
	 * apart. The history socket can need far longer than the connect timeout.
	 */
	private _awaitingReplayVerdict = false;
	/**
	 * Polled evidence (`isTxConfirmed`, the reconcile queue) is held from a hold
	 * until a verdict binds or rolls back the head, or a live frame names it.
	 * Survives a live socket close: the verdict of a pass that closes meanwhile
	 * is ignored, and it may be a rollback. A pass that closes naming the head
	 * still emits TxConfirmed, on the trust of a normal session.
	 */
	private _evidenceHeld = false;
	/**
	 * A history pass this session restarted for a held Idle has not closed yet.
	 * It read the log after the node was Idle, so a live re-greet keeps it.
	 * Survives a live socket close: it belongs to the history socket.
	 */
	private _historyRereadPending = false;
	private _headClock: HydraHeadClock | undefined;
	/**
	 * Whether the node says it is caught up with its chain, from
	 * `Greetings.chainSyncedStatus` and the `NodeSynced`/`NodeUnsynced`
	 * transitions. `undefined` until the node has said either way.
	 *
	 * Kept because a node that is behind parks lifecycle commands rather than
	 * refusing them, and a parked Init was seen to never run (2026-09-07) —
	 * the one outcome no frame reports. Callers gate on this before sending.
	 */
	private _chainSynced: boolean | undefined;
	private readonly _heldBack = new HeldBackEmissions();

	/**
	 * Deposits approved for folding in but not yet finalized.
	 *
	 * A counter rather than a flag: nothing stops a second deposit being approved
	 * before the first finalizes, and a flag cleared by the first would reopen
	 * the window the second is still inside.
	 */
	private _pendingIncrementCount = 0;
	/**
	 * UTxO references (`txHash#index`) belonging to deposits still being folded
	 * in — visible in the snapshot, not yet spendable.
	 */
	private readonly _pendingIncrementUtxos = new Set<string>();

	constructor(
		private readonly host: LiveFrameHost,
		/** The session's event surface; the node itself. */
		private readonly emitter: EventEmitter,
	) {}

	get status(): HydraHeadStatus {
		return this._status;
	}

	get liveSessionHeadId(): string | undefined {
		return this._liveSessionHeadId;
	}

	get livePartyIdentityVerified(): boolean {
		return this._livePartyIdentityVerified;
	}

	/** See `_evidenceHeld`. The session must not act on replayed evidence meanwhile. */
	get isEvidenceHeld(): boolean {
		return this._evidenceHeld;
	}

	get headClock(): HydraHeadClock | undefined {
		return this._headClock;
	}

	get hasPendingIncrement(): boolean {
		return this._pendingIncrementCount > 0;
	}

	/** See `_chainSynced`. `undefined` means the node has not said yet. */
	get chainSynced(): boolean | undefined {
		return this._chainSynced;
	}

	get pendingIncrementUtxoRefs(): ReadonlySet<string> {
		return this._pendingIncrementUtxos;
	}

	isLiveSessionReady(): boolean {
		const isHeadReady = this.host.expectedHeadId == null || this._liveSessionHeadId === this.host.expectedHeadId;
		const requiresIdentityBearingGreetings = this.host.expectedHeadId != null || this.host.configuredKeyCount > 0;
		const isPartyReady = !requiresIdentityBearingGreetings || this._livePartyIdentityVerified;
		return this.host.persistenceRotationError == null && isHeadReady && isPartyReady;
	}

	/** Connect may return: the session is ready, or it holds a headless Idle for the replay to decide. */
	isConnectSettled(): boolean {
		return this.isLiveSessionReady() || (this._awaitingReplayVerdict && this.host.persistenceRotationError == null);
	}

	/**
	 * The replay decided the headless Idle this session holds, if it holds one.
	 * A history that names the head disagrees with this Greetings, so the live
	 * socket greets again instead of either side being guessed.
	 */
	settleHeadlessIdle(verdict: 'finalized' | 'rolled-back' | 'disagrees'): void {
		// Every closed pass reports here, held or not: the next hold reads again.
		this._historyRereadPending = false;
		if (!this._awaitingReplayVerdict) return;
		this._awaitingReplayVerdict = false;
		if (verdict === 'finalized') this.bindFinalizedHead();
		else if (verdict === 'rolled-back') this.reportRollbackToIdle();
		else {
			this.host.invalidateLiveConnection(
				new HydraTransportError('Hydra history names the head the live Greetings did not; greeting again'),
			);
		}
	}

	/**
	 * The node is Idle because the pinned head is finalized: the session is that
	 * head's, in the state an in-process HeadIsFinalized leaves it. Party
	 * identity was proven by the live Greetings, the head by the node's history.
	 */
	private bindFinalizedHead(): void {
		this._evidenceHeld = false;
		this._liveSessionHeadId = this.host.expectedHeadId;
		this.flushHeldBackWhenLive();
		// The close's snapshot is the tip the handoff checks the fanout against.
		// A service that was down from Open to here never heard HeadIsClosed.
		this.emitStatusChange(HydraHeadStatus.Final, this.host.expectedHeadId, this.host.finalizedSnapshotNumber());
		this.emitter.emit(LIVE_SESSION_READY_EVENT);
	}

	/**
	 * An L1 rollback before/through Init legitimately returns hydra-node to
	 * Idle, where no head id exists. Clear the old session proof before
	 * emitting the regression so the manager can durably invalidate routing.
	 */
	private reportRollbackToIdle(): void {
		this._evidenceHeld = false;
		this._liveSessionHeadId = undefined;
		this._headClock = undefined;
		this.host.clearFinalizedFanout();
		this.emitStatusChange(HydraHeadStatus.Idle, undefined);
	}

	/**
	 * A live frame named the head: whatever a held headless Idle said is out of
	 * date. So is a pass reread for it: it started before any later Idle.
	 */
	private bindLiveHead(headId: string): void {
		this._liveSessionHeadId = headId;
		this._awaitingReplayVerdict = false;
		this._evidenceHeld = false;
		this._historyRereadPending = false;
	}

	private emitStatusChange(status: HydraHeadStatus, headId: string | undefined, snapshotNumber?: number): void {
		if (this._status === status) return;
		this._status = status;
		this.emitter.emit(HydraNodeEvent.StatusChange, {
			status,
			headId,
			snapshotNumber,
			contestationDeadline: undefined,
		} satisfies StatusChangeData);
	}

	/** The session's identity proof is gone (socket closed, rotation, rejection). */
	clearLiveIdentity(): { hadLiveIdentity: boolean } {
		const hadLiveIdentity = this._liveSessionHeadId != null || this._livePartyIdentityVerified;
		this._liveSessionHeadId = undefined;
		this._livePartyIdentityVerified = false;
		this._awaitingReplayVerdict = false;
		this._headClock = undefined;
		this.clearPendingIncrements();
		return { hadLiveIdentity };
	}

	resetOnDisconnect(): void {
		this._status = HydraHeadStatus.Disconnected;
		this._liveSessionHeadId = undefined;
		this._livePartyIdentityVerified = false;
		this._awaitingReplayVerdict = false;
		this._evidenceHeld = false;
		this._historyRereadPending = false;
		this._headClock = undefined;
		// A closed transport says nothing about whether the node is still caught
		// up; the next Greetings re-establishes it.
		this._chainSynced = undefined;
		this.clearPendingIncrements();
	}

	/**
	 * Forget deposits this session saw being folded in.
	 *
	 * The pair is derived from `CommitApproved`/`CommitFinalized`, which are live
	 * frames only: the live socket is opened with `history=no`, and the replay
	 * handles no `Commit*` tag but `CommitRecorded`. A finalization that lands
	 * while the socket is down is therefore never observed by anything, so state
	 * carried across the gap can only be wrong — and it was wrong in the
	 * expensive direction: the counter stayed above zero for the life of the
	 * attachment, and every UTxO in the set stayed excluded from withdrawal and
	 * from L2 locking, so the topped-up funds could not leave the head at all.
	 *
	 * Clearing can re-open the fold-in window for a deposit that really is still
	 * in flight. That costs a transaction refused with "inputs are spent", which
	 * is retried; the alternative cost funds that never move again.
	 */
	private clearPendingIncrements(): void {
		this._pendingIncrementCount = 0;
		this._pendingIncrementUtxos.clear();
	}

	/** Replay met a deposit record; hold it with the live-observed ones. */
	rememberReplayedDeposit(data: DepositRecordedData): void {
		this._heldBack.rememberDeposit(data);
		this.flushHeldBackWhenLive();
	}

	/** Replay met a withdrawal settling; same handling as a deposit. */
	rememberReplayedDecommit(data: DecommitSettledData): void {
		this._heldBack.rememberDecommit(data);
		this.flushHeldBackWhenLive();
	}

	/**
	 * Emit what replay left behind, as soon as there is a proven identity to
	 * emit it under.
	 *
	 * The only other drain is at the end of `processStatus`, which needs a live
	 * frame to arrive — and a quiet head sends none: Hydra 2.3 does not stream
	 * ticks over the API, and the clock refresh that compensates runs on its own
	 * probe socket. Replay reaches this class after the live `Greetings` has
	 * already authenticated the session, so on an idle head a deposit or a
	 * settlement met only in history was parked here with nothing left to release
	 * it — the deposit's deadline never written, the withdrawal never finalized.
	 */
	private flushHeldBackWhenLive(): void {
		if (!this.isLiveSessionReady()) return;
		// Withdrawals before deposits, and each oldest-first, exactly as the live
		// path drains them: an approval must not be applied after the
		// finalization that followed it.
		this._heldBack.flushDecommits((data) => this.emitter.emit(HydraNodeEvent.DecommitSettled, data));
		this._heldBack.flushDeposits((data) => this.emitter.emit(HydraNodeEvent.DepositRecorded, data));
		this._heldBack.flushPostTxFailures((data) => this.emitter.emit(HydraNodeEvent.PostTxFailed, data));
	}

	applyObservedHeadClock(chainTimeMs: number, chainSlot: number): void {
		if (
			!Number.isSafeInteger(chainTimeMs) ||
			chainTimeMs < EARLIEST_PLAUSIBLE_HEAD_CLOCK_MS ||
			chainTimeMs > Date.now() + MAX_HEAD_CLOCK_FUTURE_SKEW_MS ||
			!Number.isSafeInteger(chainSlot) ||
			chainSlot < 0
		) {
			return;
		}
		this._headClock = { chainTimeMs, chainSlot, receivedAtMs: Date.now() };
	}

	processHeadClock(rawMessage: string): void {
		try {
			const parsed = headClockMessageSchema.safeParse(parseBoundedJsonFrame(rawMessage));
			if (!parsed.success) return;
			assertExpectedFrameHeadId(parsed.data, this.host.expectedHeadId);
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

	processStatus(rawMessage: string): void {
		// Validated with every other frame below, but emitted only once the live
		// session has been authenticated. Unlike the increment bookkeeping beside
		// it, decommit/deposit outcomes write to the database, so they wait for
		// the same proof of identity every other persisted transition does.
		let decommitSettled: ReturnType<typeof readDecommitSettled>;
		let depositRecorded: DepositRecordedData | undefined;
		let postTxFailed: PostTxFailedData | undefined;
		/** Acted on after the status change is emitted, never before — see below. */
		let headWasAborted = false;
		try {
			const message = parseBoundedJsonFrame(rawMessage);
			this.host.assertPersistenceReplayIsSupported(message);
			const envelope = messageSchema.parse(message);
			const suppliedHeadId = assertExpectedFrameHeadId(envelope, this.host.expectedHeadId);
			// Under the etcd network layer these mean "this node is in the majority
			// cluster", so for a two-party head they say the counterparty's node is
			// up and reachable. They say nothing about whether it has finished
			// syncing the chain, which is why this is reported and not gated on.
			if (envelope.tag === 'NetworkConnected' || envelope.tag === 'PeerConnected') {
				this.host.setNetworkConnected(true);
			}
			if (envelope.tag === 'NetworkDisconnected' || envelope.tag === 'PeerDisconnected') {
				this.host.setNetworkConnected(false);
			}
			// Hydra 2.4 removed the `SyncedStatusReport` server output and reports
			// chain-sync as these two transitions instead (the same state is also on
			// `Greetings.chainSyncedStatus`, which is what the head-clock probe and
			// the Host's drift watchdog actually read).
			//
			// Reported, never gated on. A node that has fallen behind the chain
			// rejects client input on its own (`RejectedInputBecauseUnsynced`), and
			// the guards that matter — the head clock's freshness check and the
			// Host's drift watchdog — already fail closed without this frame. Acting
			// on it here would add a second, weaker path to the same decision. What
			// it is worth is telling an operator why a head went quiet, which
			// otherwise leaves no trace in this service's logs at all.
			if (envelope.tag === 'NodeUnsynced') {
				this._chainSynced = false;
				logger.warn('[HydraNode] Node reports it has fallen behind the chain', {
					headId: this.host.expectedHeadId,
				});
			}
			if (envelope.tag === 'NodeSynced') {
				this._chainSynced = true;
				logger.info('[HydraNode] Node reports it has caught up with the chain', {
					headId: this.host.expectedHeadId,
				});
			}
			if (envelope.tag === 'HeadIsAborted') {
				headWasAborted = true;
			}
			if (envelope.tag === 'HeadIsInitializing' || envelope.tag === 'HeadIsOpen') {
				// `HeadIsOpen` is guarded on actually carrying `parties`, matching the
				// replay pass. Unguarded, the same frame was valid on replay and threw
				// here — a live-only fail-closed divergence from the contract replay
				// establishes, which cost the session over a frame replay accepts.
				if (
					envelope.tag === 'HeadIsInitializing' ||
					(typeof message === 'object' && message !== null && 'parties' in message)
				) {
					this.host.bindSnapshotPartyOrder(message);
				}
				if (suppliedHeadId) this.bindLiveHead(suppliedHeadId);
			}
			if (envelope.tag === 'Greetings') {
				// A Greetings that carries the field settles the sync state either way;
				// one that omits it (older node, offline head) leaves it unknown rather
				// than guessing.
				const syncedStatus = (message as { chainSyncedStatus?: unknown }).chainSyncedStatus;
				if (typeof syncedStatus === 'string') this._chainSynced = syncedStatus === 'InSync';
				const isHeadlessIdle =
					this.host.expectedHeadId != null && suppliedHeadId == null && envelope.headStatus === HydraHeadStatus.Idle;
				if (this.host.expectedHeadId && !suppliedHeadId && !isHeadlessIdle) {
					throw new HydraProtocolError('Pinned Hydra session Greetings omitted its head identifier');
				}
				this.host.verifyGreetingsPartyIdentity(message);
				// Only after identity: a rejected Greetings must not release a hold.
				if (suppliedHeadId) this.bindLiveHead(suppliedHeadId);
				this._livePartyIdentityVerified = true;
				if (isHeadlessIdle) {
					// Party identity still binds this configured endpoint. Whether the
					// pinned head is finalized or rolled back is the history's to say.
					this._liveSessionHeadId = undefined;
					this._headClock = undefined;
					if (this.host.finalizedHeadProven()) this.bindFinalizedHead();
					else {
						// Never decided from a pass that started earlier. A closed one can
						// still hold a HeadIsFinalized in its queue, and hydra-node greets a
						// streaming one with the current status before it forwards a
						// HeadIsFinalized written after that pass read the log. A rollback
						// read from either would undo a fanned-out head. No time bound
						// either: a history that never reaches its Greetings keeps this held
						// and fail-closed, each failed pass recorded as a head error. A
						// timeout read as a rollback could disable a head that fanned out
						// while this service was down.
						this._awaitingReplayVerdict = true;
						this._evidenceHeld = true;
						// Settles connect() only: isLiveSessionReady stays false, so websocket
						// commands are refused and outcomes stay held until the verdict.
						if (this.isConnectSettled()) this.emitter.emit(LIVE_SESSION_READY_EVENT);
						if (!this._historyRereadPending) {
							this._historyRereadPending = true;
							this.host.rereadHistory();
						}
					}
					return;
				}
				if (this.isLiveSessionReady()) this.emitter.emit(LIVE_SESSION_READY_EVENT);
			}
			if (envelope.tag === 'HeadIsFinalized' && hasFinalizedUtxoField(message)) {
				this.host.recordFinalizedFanout(message);
			}
			// A deposit is folded in over two events, and in between the head has
			// agreed to spend its current UTxO set without having produced the
			// replacement yet. Anything built against that set in the gap is refused
			// with "all inputs are spent", which reads like a bug in the transaction
			// and is really a race with the fold-in. Every deposit opens this window,
			// not just a head's first.
			if (envelope.tag === 'CommitApproved') {
				this._pendingIncrementCount += 1;
				this.recordPendingIncrementUtxos(message);
			}
			// The deadline the head will hold this deposit to. Set from the chain
			// time of whichever node drafted the deposit, so it cannot be derived
			// from the transaction or from when the operator asked.
			if (envelope.tag === 'CommitRecorded') {
				depositRecorded = readDepositRecorded(message);
			}
			decommitSettled = readDecommitSettled(envelope.tag, message);
			if (envelope.tag === 'PostTxOnChainFailed') {
				const failure = readPostTxFailed(message, this.host.expectedHeadId, (headId) =>
					logger.warn('[HydraNode] Ignoring a failed L1 transaction for another head', { headId }),
				);
				// Asked now, while the frame is current: the waiting command settles on
				// this same frame and is gone by the time anything reads the event.
				if (failure) {
					postTxFailed = { ...failure, answersCommand: this.host.isAwaitingPostChainTx(failure.postChainTxTag) };
				}
			}
			if (envelope.tag === 'CommitRecovered') {
				// Deliberately does NOT decrement. Recovery is the path for a deposit
				// the head did not take, so a recovered deposit was never
				// `CommitApproved` and never incremented this count — decrementing here
				// spent an unrelated, still-pending deposit's slot, cleared the fold-in
				// set while that deposit was in flight, and every L2 transaction built
				// against its outputs came back "all inputs are spent".
				//
				// If a recovery could ever follow an approval, the cost of this is
				// over-blocking until the next finalization, which is the direction the
				// comment below already argues for.
				this.emitter.emit(HydraNodeEvent.IncrementFinalized);
			}
			if (envelope.tag === 'CommitFinalized') {
				this._pendingIncrementCount = Math.max(0, this._pendingIncrementCount - 1);
				// Only once nothing is in flight. A finalization names its deposit but
				// an approval does not, so with two deposits pending there is no way
				// to tell which set just became spendable. Holding both until the
				// last one lands over-blocks for a few minutes; releasing early
				// re-creates the failure this exists to prevent.
				if (this._pendingIncrementCount === 0) {
					this._pendingIncrementUtxos.clear();
				}
				this.emitter.emit(HydraNodeEvent.IncrementFinalized);
			}
		} catch (error) {
			if (error === this.host.persistenceRotationError) {
				this.host.onRotationError(error);
			} else if (isConnectionBindingFrame(rawMessage)) {
				const identityError =
					error instanceof Error ? error : new HydraProtocolError('Hydra live session identity validation failed');
				this._liveSessionHeadId = undefined;
				this._livePartyIdentityVerified = false;
				this._awaitingReplayVerdict = false;
				this._headClock = undefined;
				// Whatever the replay held back came over a socket whose identity has
				// just been rejected. Keeping it would mean applying, on the next
				// authenticated session, outcomes this node never accepted.
				this._heldBack.clear();
				this.emitter.emit(LIVE_SESSION_REJECTED_EVENT, identityError);
				this.host.invalidateLiveConnection(identityError);
			}
			logger.error('[HydraNode] Rejected status frame', { error: protocolErrorToString(error) });
			return;
		}

		if (!this.isLiveSessionReady()) {
			// Held rather than dropped. A withdrawal settles on L1 minutes after it
			// leaves the head, so a node restarted in between sees its finalization
			// only in the replayed history — and dropping it left the withdrawal
			// reading as still paying out forever, with nothing to correct it.
			if (decommitSettled) this._heldBack.rememberDecommit(decommitSettled);
			if (depositRecorded) this._heldBack.rememberDeposit(depositRecorded);
			if (postTxFailed) this._heldBack.rememberPostTxFailure(postTxFailed);
			return;
		}
		this._heldBack.flushDecommits((data) => this.emitter.emit(HydraNodeEvent.DecommitSettled, data));
		this._heldBack.flushDeposits((data) => this.emitter.emit(HydraNodeEvent.DepositRecorded, data));
		if (decommitSettled) this.emitter.emit(HydraNodeEvent.DecommitSettled, decommitSettled);
		if (depositRecorded) this.emitter.emit(HydraNodeEvent.DepositRecorded, depositRecorded);
		const changeData = extractStatusChangeData(rawMessage, this.host.expectedHeadId);
		if (changeData && changeData.status !== HydraHeadStatus.Final) {
			// A history replay can contain a prior Final while the authenticated
			// live Greetings reports a rolled-back/non-Final tip. Never carry the
			// old fanout map into a later finalization attempt.
			this.host.clearFinalizedFanout();
		}
		if (changeData && changeData.status !== this._status) {
			this._status = changeData.status;
			this.emitter.emit(HydraNodeEvent.StatusChange, changeData);
		}
		// After the status change: a listener records the failure with the node's
		// status, and the frame that releases held failures is the authenticating
		// Greetings, which is also what moves the status off its initial value.
		this._heldBack.flushPostTxFailures((data) => this.emitter.emit(HydraNodeEvent.PostTxFailed, data));
		if (postTxFailed) this.emitter.emit(HydraNodeEvent.PostTxFailed, postTxFailed);
		if (headWasAborted) {
			// The head is over before it ever opened, and nothing this session proved
			// about it survives: there is no head left to clock, and a fanout map
			// held from a replay belongs to a head that no longer exists. The same
			// clearing a rollback verdict on a headless Idle Greetings does, for the
			// same reason: both describe a node back at Idle.
			//
			// After the emission above, not before: clearing the session head id
			// makes `isLiveSessionReady` false, and the early return that follows
			// from it would swallow the very status change this exists to deliver.
			this._liveSessionHeadId = undefined;
			this._headClock = undefined;
			this.host.clearFinalizedFanout();
		}
	}

	/**
	 * Remember what a `CommitApproved` says is arriving.
	 *
	 * Best-effort by design: the frame comes from another process, so a shape we
	 * do not recognise leaves the set as it was. Missing a reference costs one
	 * rejected transaction, which is what happened before any of this existed;
	 * throwing here would take down a live session over diagnostics.
	 */
	private recordPendingIncrementUtxos(message: unknown): void {
		if (typeof message !== 'object' || message === null || !('utxoToCommit' in message)) return;
		const utxoToCommit = (message as { utxoToCommit?: unknown }).utxoToCommit;
		if (typeof utxoToCommit !== 'object' || utxoToCommit === null) return;
		for (const reference of Object.keys(utxoToCommit)) {
			if (HYDRA_UTXO_REFERENCE_PATTERN.test(reference)) {
				this._pendingIncrementUtxos.add(reference.toLowerCase());
			}
		}
	}
}
