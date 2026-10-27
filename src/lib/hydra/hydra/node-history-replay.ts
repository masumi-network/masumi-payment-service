/**
 * The history replay pass: folding the evidence socket's replayed frames into
 * a verified signed-state anchor, and refusing to form one when the history
 * cannot be proven.
 *
 * Everything here is re-derived per connection by design (ADR-0012): a
 * replacement history socket always scans from the beginning, signatures are
 * re-verified, and the anchor is re-earned. The reconciliation cursor is a
 * durable input. Verified signed snapshots are stored as recovery evidence,
 * but replay never trusts those rows as a verification shortcut.
 *
 * The replay owns pass-local state only. Anything shared with the live
 * session — party identity, the finalized fanout map, held-back deposit and
 * withdrawal outcomes, the persistence-rotation latch — is reached through
 * the host seam, so the two sockets can never disagree about it.
 */

import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { Connection } from './connection';
import { HydraProtocolError, HydraTransportError } from './errors';
import { ConfirmedTransactionLedger } from './node-confirmed-ledger';
import {
	assertExpectedFrameHeadId,
	parseBoundedJsonFrame,
	protocolErrorToString,
	readClosedSnapshotNumber,
	readDecommitSettled,
	readDepositRecorded,
} from './node-frames';
import { MAX_HYDRA_WS_FRAME_BYTES } from './schemas';
import { describeProtocolDrift, detectSnapshotDrift, type ProtocolDrift } from './protocol-drift';
import { markDriftReported } from './params-drift';
import {
	greetingsSnapshotMessageSchema,
	historyHeadIsOpenMessageSchema,
	historySnapshotConfirmedMessageSchema,
	hydraHeadStatusSchema,
	messageSchema,
	decommitRequestedMessageSchema,
	hasFinalizedUtxoField,
} from './schemas';
import {
	correlateDecommitOutcome,
	rememberDecommitTransaction,
	resolveNewlyDeclaredDecommitTransactions,
	type DecommitOutcomeCursor,
} from './decommit-resolution';
import * as l2Mint from './l2-mint-tally';
import {
	completeHydraSnapshotVerification,
	doesHydraTransactionTransitionReachSnapshot,
	serializeHydraSnapshotOutput,
	verifyHydraSnapshotSignatures,
	type VerifiedHydraSnapshot,
} from './snapshot-verification';
import { computeHydraAccumulatorHash } from './snapshot-accumulator';
import { HistoryFrameQueue, type QueuedHistoryFrame } from './node-history-frame-queue';
import { assertSafeFirstHistorySnapshot, isIdenticalSignedSnapshotRedelivery } from './node-history-snapshot-guards';
import { pageClosedBeforeHeadExisted } from './node-history-page';
import type { HistoryReplayHost } from './node-history-replay-host';
import { HydraTransaction } from './types';

const HISTORY_STATUS_REQUIRING_STATE_ANCHOR = new Set<HydraHeadStatus>([
	HydraHeadStatus.Open,
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.FanningOut,
	HydraHeadStatus.Final,
]);

const MAX_UNPINNED_HISTORY_BUFFER_BYTES = 8 * 1024 * 1024;
/** Bounds per-frame overhead and work when the pre-pin page is flushed, even for tiny frames. */
const MAX_UNPINNED_HISTORY_BUFFER_FRAMES = 4_096;

/**
 * One frame's work at least this long is reported. The queue yields between
 * frames, so this is the longest a single frame held the event loop — and
 * nothing else in the process ran meanwhile.
 */
const SLOW_REPLAY_WORK_MS = 1_000;

export class HydraHistoryReplay {
	private _complete = false;
	private _failed = false;
	private _error: Error | undefined;
	private _sessionHeadId: string | undefined;
	/** The pinned head this pass saw finalized. Pass-local: a fresh pass must read the log again. */
	private _finalizedHeadId: string | undefined;
	private _truncated = false;
	private _restartRequested = false;
	private _unpinnedFrames: string[] = [];
	private _unpinnedBytes = 0;
	private _lastSequence: number | undefined;
	/** Highest `seq` of any frame this pass, and whether its Greetings arrived. */
	private _maxFrameSequence: number | undefined;
	private _pastGreetings = false;
	private _partyIdentityVerified = false;
	private _verifiedSnapshot: VerifiedHydraSnapshot | undefined;
	/** Newest snapshot a close or contest put on chain this pass. Only history has it after a restart. */
	private _closedSnapshotNumber: number | undefined;
	/**
	 * The exact signed payload behind `_verifiedSnapshot` (version, accumulator,
	 * party signatures), kept only to tell an idempotent re-delivery of that same
	 * signed snapshot — what a node side-load produces, see ADR 0015 §4 — apart
	 * from a genuine replay/regression at the same snapshot number. Not itself
	 * security-bearing: `_verifiedSnapshot` already reflects a frame that passed
	 * full multi-signature and accumulator verification before this is set.
	 */
	private _lastVerifiedFrame: { version: number; accumulator: string; signatures: string } | undefined;
	/**
	 * Frames waiting to be processed, oldest first, each tagged with the pass it
	 * arrived in. A frame's pass ends when `resetPass` starts a new one, and a
	 * frame from an ended pass is dropped unread: it belongs to a socket that is
	 * already gone.
	 *
	 * `_failed` cannot stand in for the tag: rejecting invalidates the socket,
	 * the socket's close handler starts a fresh pass, and a fresh pass clears
	 * `_failed` — all synchronously, before `fail()` returns.
	 */
	private readonly _queue = new HistoryFrameQueue(
		(frame) => this.processQueuedFrame(frame),
		(frame) => frame.pass === this._pass && !this._failed && !this.host.persistenceRotationError,
		{ pause: () => this.connection.pauseReceiving(), resume: () => this.connection.resumeReceiving() },
	);
	private _pass = 0;

	/**
	 * Decommit transactions seen so far, by transaction id. Bounded: a head
	 * replays its whole history on every connection, and only a decommit still
	 * named by a snapshot's pending partition can be needed.
	 */
	private readonly _decommitTransactions = new Map<string, HydraTransaction>();
	private readonly _decommitOutcomeCursor: DecommitOutcomeCursor = {};

	/** Unknown snapshot fields already reported, so a replay says it once. */
	private readonly _reportedDriftFields = new Set<string>();

	/** Net L2 mint over this pass's confirmed transactions, reported while current; see `l2-mint-tally`. */
	private _l2MintTally: l2Mint.L2MintTally = { units: new Map() };

	constructor(
		private readonly connection: Connection,
		private readonly ledger: ConfirmedTransactionLedger,
		private readonly host: HistoryReplayHost,
	) {}

	get isComplete(): boolean {
		return this._complete;
	}

	get isFailed(): boolean {
		return this._failed;
	}

	get error(): Error | undefined {
		return this._error;
	}

	get sessionHeadId(): string | undefined {
		return this._sessionHeadId;
	}

	/**
	 * The pass accepted its closing Greetings and has not failed since, so it
	 * reports nothing more. A truncated pass counts: it still checked every frame.
	 */
	get isClosed(): boolean {
		return this._partyIdentityVerified && !this._failed;
	}

	/** The pinned head this pass saw finalized, once the pass is closed. */
	get finalizedHeadId(): string | undefined {
		return this.isClosed ? this._finalizedHeadId : undefined;
	}

	/** The snapshot that finalized head settled on: its close, or a later contest. */
	get finalizedSnapshotNumber(): number | undefined {
		return this.finalizedHeadId ? this._closedSnapshotNumber : undefined;
	}

	get partyIdentityVerified(): boolean {
		return this._partyIdentityVerified;
	}

	get verifiedSnapshot(): VerifiedHydraSnapshot | undefined {
		return this._verifiedSnapshot;
	}

	get closedSnapshotNumber(): number | undefined {
		return this._closedSnapshotNumber;
	}

	/** Unburned L2 mints as of the last verified snapshot. Undefined until this pass has replayed the whole history. */
	get l2MintCheck(): l2Mint.L2MintCheck | undefined {
		const snapshot = this._complete && !this._failed ? this._verifiedSnapshot : undefined;
		return snapshot && l2Mint.buildL2MintCheck(this._l2MintTally, snapshot);
	}

	fail(error: unknown): void {
		const normalizedError =
			error instanceof HydraProtocolError || error instanceof HydraTransportError
				? error
				: new HydraProtocolError('Hydra history replay failed protocol validation', { cause: error });
		const isFirstFailure = !this._failed;
		this._failed = true;
		this._complete = false;
		this._error = normalizedError;
		this._unpinnedFrames = [];
		this._unpinnedBytes = 0;
		const isUnsupportedPersistenceRotation = normalizedError === this.host.persistenceRotationError;
		if (isUnsupportedPersistenceRotation) {
			this.host.onRotationReplayFailure(normalizedError as HydraProtocolError);
		}
		if (isFirstFailure) {
			this.host.onReplayFailed(normalizedError);
			logger.error('[HydraNode] History replay rejected a protocol frame', {
				error: protocolErrorToString(normalizedError),
			});
			if (!isUnsupportedPersistenceRotation) {
				// A malformed pass must never remain latched on the same byte stream.
				// Connection invalidation closes the bad socket and schedules a clean replay.
				this.connection.invalidate(normalizedError);
			}
		}
	}

	/**
	 * A replacement history socket always scans from the beginning. Preserve
	 * already verified positive evidence until its durable cursor is advanced,
	 * but discard every unauthenticated/pass-local assertion.
	 */
	resetPass(): void {
		this._pass += 1;
		this._queue.clear();
		this._complete = false;
		this._failed = false;
		this._sessionHeadId = undefined;
		this._finalizedHeadId = undefined;
		this._truncated = false;
		this._restartRequested = false;
		this._unpinnedFrames = [];
		this._unpinnedBytes = 0;
		this._lastSequence = undefined;
		this._maxFrameSequence = undefined;
		this._pastGreetings = false;
		this._partyIdentityVerified = false;
		this._verifiedSnapshot = undefined;
		this._lastVerifiedFrame = undefined;
		this._closedSnapshotNumber = undefined;
		this._decommitOutcomeCursor.approval = undefined;
		this._l2MintTally = { units: new Map() };
		const rotationError = this.host.persistenceRotationError;
		if (rotationError) {
			this._failed = true;
			this._error = rotationError;
		}
	}

	setErrorToRotationLatch(): void {
		this._error = this.host.persistenceRotationError;
	}

	maybeRestartTruncated(): void {
		if (!this._truncated || !this._partyIdentityVerified || this.ledger.hasUnreconciled || this._restartRequested) {
			return;
		}
		this._restartRequested = true;
		this.connection.restart(
			new HydraTransportError('Hydra bounded history page was durably reconciled; restarting replay'),
		);
	}

	processMessage(rawMessage: string): void {
		if (this._failed || this.host.persistenceRotationError) return;
		if (this.host.expectedHeadId == null) {
			this.bufferUnpinnedFrame(rawMessage);
			return;
		}
		this._queue.push({ rawMessage, pass: this._pass });
	}

	private processQueuedFrame({ rawMessage, pass }: QueuedHistoryFrame): Promise<void> | undefined {
		const startedAtMs = Date.now();
		const pending = this.processPinnedMessage(rawMessage, pass);
		const elapsedMs = Date.now() - startedAtMs;
		if (elapsedMs >= SLOW_REPLAY_WORK_MS) {
			logger.warn('[HydraNode] One history frame held the event loop', {
				headId: this.host.expectedHeadId,
				frameBytes: Buffer.byteLength(rawMessage, 'utf8'),
				elapsedMs,
			});
		}
		return pending;
	}

	private bufferUnpinnedFrame(rawMessage: string): void {
		const frameBytes = Buffer.byteLength(rawMessage, 'utf8');
		if (
			this._unpinnedFrames.length >= MAX_UNPINNED_HISTORY_BUFFER_FRAMES ||
			frameBytes > MAX_HYDRA_WS_FRAME_BYTES ||
			this._unpinnedBytes + frameBytes > MAX_UNPINNED_HISTORY_BUFFER_BYTES
		) {
			this.fail(new HydraProtocolError('Hydra history exceeded the bounded buffer before its head id was pinned'));
			return;
		}
		this._unpinnedFrames.push(rawMessage);
		this._unpinnedBytes += frameBytes;
	}

	processBufferedUnpinnedFrames(): void {
		if (this.host.expectedHeadId == null || this._unpinnedFrames.length === 0) return;
		const bufferedFrames = this._unpinnedFrames;
		this._unpinnedFrames = [];
		this._unpinnedBytes = 0;
		// A page captured before the head existed is stale, not forged. Judging it
		// under the pin that arrived afterwards is what turned every freshly opened
		// head into a CommandFailed: the socket connects while the node is still
		// Idle, so the whole page — its closing Greetings included — is buffered
		// unpinned; HeadIsOpen then pins the id and flushes the buffer here, and
		// that Greetings is asked to name a head that did not exist when it was
		// written. Read it again instead, now that there is a head to read it
		// against.
		if (pageClosedBeforeHeadExisted(bufferedFrames)) {
			this._restartRequested = true;
			this.connection.restart(
				new HydraTransportError('Hydra history page closed before the head existed; restarting replay'),
			);
			return;
		}
		// Ahead of anything already queued: these frames arrived first. Tagged
		// with the current pass, so a rejection among them — which invalidates the
		// socket and starts a fresh pass — drops the rest instead of reading them
		// as that fresh pass.
		this._queue.pushFront(bufferedFrames.map((rawMessage) => ({ rawMessage, pass: this._pass })));
	}

	/** Returns a promise while accumulator work or durable snapshot storage is pending. */
	private processPinnedMessage(rawMessage: string, pass: number): Promise<void> | undefined {
		try {
			const message = parseBoundedJsonFrame(rawMessage);
			this.host.assertPersistenceReplayIsSupported(message);
			const parsedEnvelope = messageSchema.parse(message);
			assertExpectedFrameHeadId(parsedEnvelope, this.host.expectedHeadId);
			// hydra-node subscribes a socket to live outputs BEFORE it streams the
			// history (WSServer.wsApp: dupTChan, then forwardHistory), so an output
			// persisted during a long replay arrives twice: in the history, then
			// again after Greetings with the same seq. Rejecting the copy failed
			// the pass, and the next pass on a busy head met the same race. A seq
			// at or below one this pass already holds is that copy, and only after
			// Greetings: inside the history itself a repeat is still an error.
			const frameSequence = (message as { seq?: unknown }).seq;
			if (typeof frameSequence === 'number') {
				if (this._pastGreetings && this._maxFrameSequence != null && frameSequence <= this._maxFrameSequence) {
					return undefined;
				}
				this._maxFrameSequence = Math.max(this._maxFrameSequence ?? frameSequence, frameSequence);
			}
			// Learn the peer link from replay as well as from live frames.
			//
			// hydra-node reports it on connection EVENTS, and the live socket is
			// opened with history=no, so a service that attaches to an already-peered
			// head is never told — and said "not reported yet" for the life of the
			// head, which is exactly when everything is fine. Replay is the only
			// place that answer still exists.
			//
			// Applied in stream order, so a later disconnect still wins over an
			// earlier connect.
			if (parsedEnvelope.tag === 'NetworkConnected' || parsedEnvelope.tag === 'PeerConnected') {
				this.host.setNetworkConnected(true);
			}
			if (parsedEnvelope.tag === 'NetworkDisconnected' || parsedEnvelope.tag === 'PeerDisconnected') {
				this.host.setNetworkConnected(false);
			}
			const suppliedHeadId = assertExpectedFrameHeadId(parsedEnvelope, this.host.expectedHeadId);
			if (
				parsedEnvelope.tag === 'HeadIsInitializing' ||
				(parsedEnvelope.tag === 'HeadIsOpen' && typeof message === 'object' && message !== null && 'parties' in message)
			) {
				this.host.bindSnapshotPartyOrder(message);
			}
			if (
				parsedEnvelope.tag === 'HeadIsOpen' &&
				this.host.trustLocalNodeSnapshotMetadata &&
				typeof message === 'object' &&
				message !== null &&
				// A value test: `'utxo' in message` is true for `{ utxo: null }`, and
				// the parse then threw on a frame this replay must tolerate forever.
				(message as { utxo?: unknown }).utxo != null
			) {
				const parsedOpen = historyHeadIsOpenMessageSchema.parse(message);
				if (parsedOpen.utxo != null) this.recordUnsignedLedgerAnchor(parsedOpen.headId, parsedOpen.utxo);
			}
			if (parsedEnvelope.tag === 'HeadIsFinalized' && hasFinalizedUtxoField(message)) {
				this.host.recordFinalizedFanout(message);
				this._finalizedHeadId = suppliedHeadId;
			}
			const closedAt = readClosedSnapshotNumber(parsedEnvelope);
			if (closedAt !== undefined) this._closedSnapshotNumber = closedAt;

			// A deposit stays pending for a deposit period or more, so a service
			// that reconnected in between meets its CommitRecorded only here. Held
			// with the rest until the live session authenticates, since it is
			// written to the database like any other persisted transition.
			if (parsedEnvelope.tag === 'CommitRecorded') {
				const recorded = readDepositRecorded(message);
				if (recorded) this.host.rememberReplayedDeposit(recorded);
			}

			// And the same for a withdrawal leaving the head. A decommit settles on
			// L1 minutes after the head approves it, and the live socket is opened
			// with history=no, so a service that was down for those minutes never
			// hears the finalization from anywhere else. Without this the row stays
			// `Approved` for good — and `Approved` is what makes every later
			// withdrawal for that participant refuse with "a prior withdrawal is
			// still settling on L1". Deposits were wired through replay; withdrawals
			// were not, though the ordering guarantee that makes it safe (held back,
			// correlated in-stream, flushed oldest-first) was built for both.
			const observed = readDecommitSettled(parsedEnvelope.tag, message);
			const settled = observed && correlateDecommitOutcome(this._decommitOutcomeCursor, observed);
			if (settled) this.host.rememberReplayedDecommit(settled);

			// Before the snapshot that reflects it, always: the head reports the
			// request first, and the transaction it carries is what accounts for the
			// value change that snapshot signs.
			if (parsedEnvelope.tag === 'DecommitRequested') {
				rememberDecommitTransaction(
					this._decommitTransactions,
					decommitRequestedMessageSchema.parse(message).decommitTx,
				);
			}

			if (parsedEnvelope.tag === 'SnapshotConfirmed') {
				this.reportSnapshotDrift(message);
				const parsedMessage = historySnapshotConfirmedMessageSchema.parse(message);
				assertExpectedFrameHeadId(parsedMessage, this.host.expectedHeadId);
				// Signed states and transaction transitions are verified progressively.
				// This avoids retaining the unbounded raw prefix emitted before Greetings.
				return this.recordHistorySnapshot(parsedMessage, pass);
			}

			if (parsedEnvelope.tag === 'Greetings') {
				this.host.verifyGreetingsPartyIdentity(message);
				const parsedHeadStatus = hydraHeadStatusSchema.safeParse(parsedEnvelope.headStatus);
				if (!parsedHeadStatus.success) {
					throw new HydraProtocolError('History Greetings frame has an invalid headStatus');
				}
				// hydra-node is Idle again once a head is finalized, and an Idle
				// Greetings names no head. So a pass that finalized the pinned head
				// ends exactly like this, and the head it closes is that one.
				const isHeadlessIdle = !suppliedHeadId && parsedHeadStatus.data === HydraHeadStatus.Idle;
				// A head status after HeadIsFinalized: an L1 rollback undid the fanout.
				if (!isHeadlessIdle) this._finalizedHeadId = undefined;
				const sessionHeadId = suppliedHeadId ?? (isHeadlessIdle ? this._finalizedHeadId : undefined);
				if ((this.host.expectedHeadId || this._verifiedSnapshot) && !sessionHeadId) {
					if (isHeadlessIdle) this.host.onIdleWithoutFinalization();
					throw new HydraProtocolError('Pinned Hydra history Greetings omitted its head identifier');
				}
				if (this._verifiedSnapshot && sessionHeadId !== this._verifiedSnapshot.headId) {
					throw new HydraProtocolError('Hydra history Greetings did not identify the signed snapshot head');
				}
				// Hydra 2.3 reports the head's confirmed ledger here rather than on
				// HeadIsOpen. A head that has not signed a snapshot yet — one that has
				// just opened, or that opened with no commits at all — states its
				// ledger nowhere else, so without this it has no anchor and every L2
				// operation fails closed for the life of the head.
				if (
					HISTORY_STATUS_REQUIRING_STATE_ANCHOR.has(parsedHeadStatus.data) &&
					this._verifiedSnapshot == null &&
					this.host.trustLocalNodeSnapshotMetadata &&
					suppliedHeadId
				) {
					const greeting = greetingsSnapshotMessageSchema.parse(message);
					if (greeting.snapshotUtxo) this.recordUnsignedLedgerAnchor(suppliedHeadId, greeting.snapshotUtxo);
				}
				if (HISTORY_STATUS_REQUIRING_STATE_ANCHOR.has(parsedHeadStatus.data) && this._verifiedSnapshot == null) {
					throw new HydraProtocolError(
						'Hydra history ended without an authenticated Open or signed snapshot state anchor',
					);
				}
				if (sessionHeadId) this._sessionHeadId = sessionHeadId;
				this._partyIdentityVerified = true;
				this._pastGreetings = true;
				// Greetings authenticates the end marker, not the preceding transaction
				// metadata. A truncated page remains fail-closed until every retained
				// item has a durable cursor and a later full pass reaches this marker.
				this._complete = !this._truncated;
				if (this._complete) {
					this._error = undefined;
					this.ledger.trim();
					if (this._l2MintTally.openedBy) this.host.reportL2MintOutstanding(this._l2MintTally.openedBy);
				}
				// Before any restart: a truncated page restarts only once it is drained,
				// and a held live Idle holds the drain until this verdict.
				this.host.onPassClosed();
				if (!this._complete) this.maybeRestartTruncated();
			}
		} catch (error) {
			this.fail(error);
		}
		return undefined;
	}

	/**
	 * Anchor the head's state on the node's own report of its ledger.
	 *
	 * Used where no signed snapshot exists yet: a head that has just opened has
	 * nothing to verify a signature against, so the alternative to trusting the
	 * local node here is refusing to work with such a head at all. Gated on
	 * `trustLocalNodeSnapshotMetadata` by both callers, which is the same
	 * condition already governing every other unsigned field taken from this
	 * endpoint, so it grants nothing new.
	 *
	 * Number and version are zero: this is the state before any snapshot the
	 * parties have signed, and the first live `SnapshotConfirmed` is checked as a
	 * transition out of it. If a head that HAS signed snapshots ever reached
	 * here, that check rejects the jump and the head stays fail-closed rather
	 * than proceeding from a state nobody signed.
	 */
	private recordUnsignedLedgerAnchor(
		headId: string,
		utxo: Record<string, Parameters<typeof serializeHydraSnapshotOutput>[0]>,
	): void {
		if (this._verifiedSnapshot) {
			throw new HydraProtocolError('Hydra history attempted to replace an established signed-state anchor');
		}
		const outputs = new Map<string, string>();
		const outputMultiset = new Map<string, number>();
		for (const [reference, output] of Object.entries(utxo)) {
			const serializedOutput = serializeHydraSnapshotOutput(output);
			outputs.set(reference.toLowerCase(), serializedOutput);
			outputMultiset.set(serializedOutput, (outputMultiset.get(serializedOutput) ?? 0) + 1);
		}
		this._verifiedSnapshot = {
			headId,
			number: 0,
			version: 0,
			outputs,
			outputMultiset,
			// The collected ledger only; an incremental commit or decommit still in
			// flight is reported separately and is not part of this state.
			committedOutputs: new Map(),
			decommitOutputs: new Map(),
		};
	}

	/**
	 * Say when the node reports snapshot state this service does not model.
	 *
	 * Reports and continues, deliberately. Refusing here would turn a harmless
	 * added field into the outage this is meant to give warning of; the value is
	 * that someone hears about it while the head still works, rather than after
	 * a rejected history has already taken it down.
	 */
	private reportSnapshotDrift(message: unknown): void {
		const drift = detectSnapshotDrift(message);
		if (drift.length === 0) return;
		const fresh: ProtocolDrift[] = drift.filter((entry) =>
			// Marks every field of the entry, so the bound applies here too. An entry
			// whose fields were all seen reports nothing, exactly as before.
			entry.fields.map((field) => markDriftReported(this._reportedDriftFields, field)).some(Boolean),
		);
		if (fresh.length === 0) return;
		const description = describeProtocolDrift(fresh);
		logger.warn(`[HydraNode] ${description}`);
		this.host.onProtocolDrift(description);
	}

	/** Adopt a verified snapshot as the anchor and remember the exact signed payload behind it. */
	private captureVerifiedFrame(
		verifiedSnapshot: VerifiedHydraSnapshot,
		parsedMessage: ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>,
		pass: number,
	): Promise<boolean> | undefined {
		const capture = () => {
			if (pass !== this._pass || this._failed) return false;
			this._verifiedSnapshot = verifiedSnapshot;
			this._lastSequence = parsedMessage.seq;
			this._lastVerifiedFrame = {
				version: verifiedSnapshot.version,
				accumulator: parsedMessage.snapshot.accumulator,
				signatures: JSON.stringify(parsedMessage.signatures.multiSignature),
			};
			return true;
		};
		// Named here: fail() would report any other error as a frame that failed validation.
		const pending = this.host.persistVerifiedSnapshot?.(parsedMessage).catch((error: unknown) => {
			if (error instanceof HydraProtocolError) throw error;
			throw new HydraProtocolError('Hydra verified snapshot could not be stored', { cause: error });
		});
		return pending ? pending.then(capture) : (capture(), undefined);
	}

	/**
	 * Every party signed this snapshot, so it can win a contest even though this
	 * replay rejects how the history reached it. The write is best effort: it
	 * starts before the pass fails and ends after it. A later pass that reaches
	 * the same rejection starts the write again.
	 */
	private storeRejectedSnapshot(parsedMessage: ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>): void {
		// A synchronous throw must not replace the rejection that fails the pass.
		new Promise<void>((resolve) => resolve(this.host.persistVerifiedSnapshot?.(parsedMessage))).catch(
			(error: unknown) =>
				logger.error('[HydraNode] Could not store a signed snapshot that this replay rejected', {
					headId: parsedMessage.headId,
					number: parsedMessage.snapshot.number,
					error: error instanceof Error ? error.message : String(error),
				}),
		);
	}

	private recordHistorySnapshot(
		parsedMessage: ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>,
		pass: number,
	): Promise<void> | undefined {
		if (this._lastSequence != null && parsedMessage.seq <= this._lastSequence) {
			throw new HydraProtocolError('Hydra history sequence was duplicate or non-monotonic');
		}
		const orderedKeys = this.host.orderedSnapshotVerificationKeys;
		if (!orderedKeys) {
			throw new HydraProtocolError('SnapshotConfirmed arrived without an identity-bearing on-chain party order');
		}
		if (this._sessionHeadId && parsedMessage.headId !== this._sessionHeadId) {
			throw new HydraProtocolError('SnapshotConfirmed did not belong to the verified Hydra history session');
		}
		const signed = verifyHydraSnapshotSignatures(parsedMessage, orderedKeys);
		const computeAccumulator = this.host.computeSnapshotAccumulator ?? computeHydraAccumulatorHash;
		const accumulator = computeAccumulator([...signed.outputs.values()]);
		const adopt = (computedAccumulator: string) => {
			const verifiedSnapshot = completeHydraSnapshotVerification(signed, computedAccumulator);
			return this.adoptHistorySnapshot(parsedMessage, verifiedSnapshot, pass);
		};
		const failCurrent = (error: unknown) => {
			if (pass === this._pass && !this._failed) this.fail(error);
		};
		if (typeof accumulator === 'string') {
			return adopt(accumulator)?.catch(failCurrent);
		}
		// Judged only if its pass is still the one it arrived in: a reset while
		// the accumulator was computed means this frame's socket is gone, and its
		// verdict — acceptance or rejection — belongs to nobody.
		return accumulator
			.then((computedAccumulator) => {
				if (pass !== this._pass || this._failed) return;
				try {
					return adopt(computedAccumulator);
				} catch (error) {
					failCurrent(error);
				}
			}, failCurrent)
			.catch(failCurrent);
	}

	private adoptHistorySnapshot(
		parsedMessage: ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>,
		verifiedSnapshot: VerifiedHydraSnapshot,
		pass: number,
	): Promise<void> | undefined {
		const previousSnapshot = this._verifiedSnapshot;
		if (previousSnapshot && verifiedSnapshot.number <= previousSnapshot.number) {
			if (
				!isIdenticalSignedSnapshotRedelivery(previousSnapshot, this._lastVerifiedFrame, parsedMessage, verifiedSnapshot)
			) {
				throw new HydraProtocolError('Hydra signed snapshot number replayed or regressed');
			}
			logger.info('[HydraNode] Ignoring re-delivered signed snapshot', { number: verifiedSnapshot.number });
			this._lastSequence = parsedMessage.seq;
			return;
		}
		if (previousSnapshot == null) {
			try {
				assertSafeFirstHistorySnapshot(parsedMessage, verifiedSnapshot);
			} catch (error) {
				this.storeRejectedSnapshot(parsedMessage);
				throw error;
			}
			return this.captureVerifiedFrame(verifiedSnapshot, parsedMessage, pass)?.then(() => undefined);
		}
		// A decommit is a state-changing transaction that Hydra reports outside the
		// `confirmed` list, so the conservation walk has to be given it explicitly.
		// Without it a legitimate withdrawal looks like value appearing and
		// vanishing for no reason — the head's whole history is rejected, the live
		// session never forms, and every L2 escrow operation fails closed.
		//
		// Passed as a transaction rather than waved through as an allowance: it
		// carries its own L1 fee, and running it through the same created/consumed
		// accounting accounts for that fee exactly, with nothing relaxed.
		const transitionTransactions = [
			...parsedMessage.snapshot.confirmed,
			...resolveNewlyDeclaredDecommitTransactions(
				Object.keys(parsedMessage.snapshot.utxoToDecommit ?? {}),
				previousSnapshot.outputs,
				(txId) => this._decommitTransactions.get(txId),
			),
		];
		if (!doesHydraTransactionTransitionReachSnapshot(previousSnapshot, verifiedSnapshot, transitionTransactions)) {
			this.storeRejectedSnapshot(parsedMessage);
			// Name the transition. This rejection stops the head forming a live
			// session at all, so it is the last thing anyone hears before every L2
			// operation starts failing closed; "somewhere in the history" is not
			// enough to act on, and re-deriving it means replaying the node's log by
			// hand (see scripts/hydra-e2e/replay-check.mts).
			throw new HydraProtocolError(
				`Hydra history contained a non-consecutive or inconsistent signed-state transition ` +
					`(snapshot ${previousSnapshot.number} to ${verifiedSnapshot.number}, ` +
					`${transitionTransactions.length} transaction(s), ` +
					`${verifiedSnapshot.committedOutputs.size} pending commit output(s), ` +
					`${verifiedSnapshot.decommitOutputs.size} pending decommit output(s))`,
			);
		}
		const finish = () => {
			l2Mint.recordL2TransactionMints(this._l2MintTally, transitionTransactions, verifiedSnapshot.number);
			if (this._complete && this._l2MintTally.openedBy) this.host.reportL2MintOutstanding(this._l2MintTally.openedBy);
			const protectedProducerTxIds = this.ledger.resolveProtectedSnapshotProducerTxIds(verifiedSnapshot);
			// Hydra 2.3 signatures authenticate only the TxOut multiset. Recording
			// tx ids/CBOR additionally relies on the configured local endpoint.
			if (this.host.trustLocalNodeSnapshotMetadata && !this._truncated) {
				const { truncated } = this.ledger.record(parsedMessage, {
					emitEvent: this._complete,
					replayComplete: this._complete,
					protectedProducerTxIds,
					onConfirmed: (txId, transaction) => this.host.emitTxConfirmed(txId, transaction),
				});
				if (truncated) this.truncatePage();
			}
			this.ledger.adoptSnapshotProducerTxIds(verifiedSnapshot, protectedProducerTxIds);
		};
		const pending = this.captureVerifiedFrame(verifiedSnapshot, parsedMessage, pass);
		if (pending)
			return pending.then((accepted) => {
				if (accepted) finish();
			});
		finish();
	}

	private truncatePage(): void {
		this._truncated = true;
		this._complete = false;
		this.maybeRestartTruncated();
	}
}
