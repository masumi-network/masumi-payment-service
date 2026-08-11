/**
 * The live session's state machine: what this process believes about one head
 * *right now*, folded from the live socket's frames — head status, session
 * identity, the head clock, pending deposit fold-ins, and the outcomes held
 * back until identity is proven.
 *
 * The mirror of `HydraHistoryReplay`, for the live socket. Everything here is
 * per-session and re-derived on reconnect; identity is never assumed, only
 * proven by a Greetings that names the configured keys and pinned head.
 */

import { EventEmitter } from 'node:events';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { HydraProtocolError } from './errors';
import { type HydraHeadClock } from './node-api';
import {
	assertExpectedFrameHeadId,
	extractStatusChangeData,
	isConnectionBindingFrame,
	parseBoundedJsonFrame,
	protocolErrorToString,
	readDecommitSettled,
	readDepositRecorded,
} from './node-frames';
import { HeldBackEmissions } from './node-held-back';
import { hasFinalizedUtxoField, headClockMessageSchema, messageSchema } from './schemas';
import { DepositRecordedData, HydraNodeEvent, StatusChangeData } from './types';

export const LIVE_SESSION_READY_EVENT = 'hydraLiveSessionReady';
export const LIVE_SESSION_REJECTED_EVENT = 'hydraLiveSessionRejected';
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
	setNetworkConnected(connected: boolean): void;
	/** The rotation latch was hit on the live socket: fail the replay with it. */
	onRotationError(error: unknown): void;
	invalidateLiveConnection(error: Error): void;
}

export class LiveFrameProcessor {
	private _status: HydraHeadStatus = HydraHeadStatus.Disconnected;
	private _liveSessionHeadId: string | undefined;
	private _livePartyIdentityVerified = false;
	private _headClock: HydraHeadClock | undefined;
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

	get headClock(): HydraHeadClock | undefined {
		return this._headClock;
	}

	get hasPendingIncrement(): boolean {
		return this._pendingIncrementCount > 0;
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

	/** The session's identity proof is gone (socket closed, rotation, rejection). */
	clearLiveIdentity(): { hadLiveIdentity: boolean } {
		const hadLiveIdentity = this._liveSessionHeadId != null || this._livePartyIdentityVerified;
		this._liveSessionHeadId = undefined;
		this._livePartyIdentityVerified = false;
		this._headClock = undefined;
		return { hadLiveIdentity };
	}

	resetOnDisconnect(): void {
		this._status = HydraHeadStatus.Disconnected;
		this._liveSessionHeadId = undefined;
		this._livePartyIdentityVerified = false;
		this._headClock = undefined;
	}

	/** Replay met a deposit record; hold it with the live-observed ones. */
	rememberReplayedDeposit(data: DepositRecordedData): void {
		this._heldBack.rememberDeposit(data);
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
			if (envelope.tag === 'HeadIsInitializing' || envelope.tag === 'HeadIsOpen') {
				this.host.bindSnapshotPartyOrder(message);
				if (suppliedHeadId) this._liveSessionHeadId = suppliedHeadId;
			}
			if (envelope.tag === 'Greetings') {
				const isHeadlessIdle =
					this.host.expectedHeadId != null && suppliedHeadId == null && envelope.headStatus === HydraHeadStatus.Idle;
				if (this.host.expectedHeadId && !suppliedHeadId && !isHeadlessIdle) {
					throw new HydraProtocolError('Pinned Hydra session Greetings omitted its head identifier');
				}
				if (suppliedHeadId) {
					this._liveSessionHeadId = suppliedHeadId;
				}
				this.host.verifyGreetingsPartyIdentity(message);
				this._livePartyIdentityVerified = true;
				if (isHeadlessIdle) {
					// An L1 rollback before/through Init legitimately returns hydra-node
					// to Idle, where no head id exists. Party identity still binds this
					// configured endpoint; clear the old session proof before emitting
					// the regression so the manager can durably invalidate routing.
					this._liveSessionHeadId = undefined;
					this._headClock = undefined;
					this.host.clearFinalizedFanout();
					if (this._status !== HydraHeadStatus.Idle) {
						this._status = HydraHeadStatus.Idle;
						this.emitter.emit(HydraNodeEvent.StatusChange, {
							status: HydraHeadStatus.Idle,
							headId: undefined,
							snapshotNumber: undefined,
							contestationDeadline: undefined,
						} satisfies StatusChangeData);
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
			if (envelope.tag === 'CommitFinalized' || envelope.tag === 'CommitRecovered') {
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
