/**
 * The history replay pass: folding the evidence socket's replayed frames into
 * a verified signed-state anchor, and refusing to form one when the history
 * cannot be proven.
 *
 * Everything here is re-derived per connection by design (ADR-0012): a
 * replacement history socket always scans from the beginning, signatures are
 * re-verified, and the anchor is re-earned — persisting yesterday's
 * verification would mean trusting it. The one durable input is the
 * reconciliation cursor the ledger carries; the one durable output is what
 * the connection manager persists from the events the session emits.
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
	readDecommitSettled,
	readDepositRecorded,
} from './node-frames';
import { MAX_HYDRA_WS_FRAME_BYTES } from './schemas';
import { describeProtocolDrift, detectSnapshotDrift, type ProtocolDrift } from './protocol-drift';
import {
	greetingsSnapshotMessageSchema,
	historyHeadIsOpenMessageSchema,
	historySnapshotConfirmedMessageSchema,
	hydraHeadStatusSchema,
	messageSchema,
	decommitRequestedMessageSchema,
	hasFinalizedUtxoField,
} from './schemas';
import { resolveNewlyDeclaredDecommitTransactions } from './decommit-resolution';
import {
	doesHydraTransactionTransitionReachSnapshot,
	serializeHydraSnapshotOutput,
	verifyHydraSnapshot,
	type VerifiedHydraSnapshot,
} from './snapshot-verification';
import { DecommitSettledData, DepositRecordedData, HydraConfirmedTransaction, HydraTransaction } from './types';

const HISTORY_STATUS_REQUIRING_STATE_ANCHOR = new Set<HydraHeadStatus>([
	HydraHeadStatus.Open,
	HydraHeadStatus.Closed,
	HydraHeadStatus.FanoutPossible,
	HydraHeadStatus.Final,
]);

/**
 * How many decommit transactions to keep for transition checking.
 *
 * Only one can be pending at a time, so this is generous by design: it exists
 * so a long history cannot grow the map without bound.
 */
const MAX_TRACKED_DECOMMIT_TRANSACTIONS = 64;

const MAX_UNPINNED_HISTORY_BUFFER_BYTES = 8 * 1024 * 1024;

/** What the replay needs from the session it serves. */
export interface HistoryReplayHost {
	readonly expectedHeadId: string | undefined;
	readonly trustLocalNodeSnapshotMetadata: boolean;
	/** The latched, instance-fatal rotation error, if one was ever observed. */
	readonly persistenceRotationError: HydraProtocolError | undefined;
	readonly orderedSnapshotVerificationKeys: string[] | undefined;
	/** Throws (and latches) when the frame announces event-log rotation. */
	assertPersistenceReplayIsSupported(message: unknown): void;
	bindSnapshotPartyOrder(message: unknown): void;
	verifyGreetingsPartyIdentity(message: unknown): void;
	setNetworkConnected(connected: boolean): void;
	/** Record a finalized fanout map, shared with the live session's copy. */
	recordFinalizedFanout(message: unknown): void;
	rememberReplayedDeposit(data: DepositRecordedData): void;
	rememberReplayedDecommit(data: DecommitSettledData): void;
	emitTxConfirmed(txId: string, transaction: HydraConfirmedTransaction): void;
	onProtocolDrift(description: string): void;
	/** Rotation is fatal for this client instance: tear down the live session and both transports. */
	onRotationReplayFailure(error: HydraProtocolError): void;
	/** The first failure of a pass: surface it (event + operator record). */
	onReplayFailed(error: Error): void;
}

export class HydraHistoryReplay {
	private _complete = false;
	private _failed = false;
	private _error: Error | undefined;
	private _sessionHeadId: string | undefined;
	private _truncated = false;
	private _restartRequested = false;
	private _unpinnedFrames: string[] = [];
	private _unpinnedBytes = 0;
	private _lastSequence: number | undefined;
	private _partyIdentityVerified = false;
	private _verifiedSnapshot: VerifiedHydraSnapshot | undefined;
	/**
	 * Bumped by every rejection, and never reset.
	 *
	 * `_failed` cannot be used to tell whether a rejection happened during a
	 * stretch of code: rejecting invalidates the socket, the socket's close
	 * handler starts a fresh pass, and a fresh pass clears `_failed` — all
	 * synchronously, before `fail()` returns. A monotonic counter is the one
	 * thing that survives that.
	 */
	private _failureGeneration = 0;

	/**
	 * Decommit transactions seen so far, by transaction id. Bounded: a head
	 * replays its whole history on every connection, and only a decommit still
	 * named by a snapshot's pending partition can be needed.
	 */
	private readonly _decommitTransactions = new Map<string, HydraTransaction>();

	/** Unknown snapshot fields already reported, so a replay says it once. */
	private readonly _reportedDriftFields = new Set<string>();

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

	get partyIdentityVerified(): boolean {
		return this._partyIdentityVerified;
	}

	get verifiedSnapshot(): VerifiedHydraSnapshot | undefined {
		return this._verifiedSnapshot;
	}

	fail(error: unknown): void {
		const normalizedError =
			error instanceof HydraProtocolError || error instanceof HydraTransportError
				? error
				: new HydraProtocolError('Hydra history replay failed protocol validation', { cause: error });
		const isFirstFailure = !this._failed;
		this._failureGeneration += 1;
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
		this._complete = false;
		this._failed = false;
		this._sessionHeadId = undefined;
		this._truncated = false;
		this._restartRequested = false;
		this._unpinnedFrames = [];
		this._unpinnedBytes = 0;
		this._lastSequence = undefined;
		this._partyIdentityVerified = false;
		this._verifiedSnapshot = undefined;
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
		this.connection.invalidate(
			new HydraTransportError('Hydra bounded history page was durably reconciled; restarting replay'),
		);
	}

	processMessage(rawMessage: string): void {
		if (this._failed || this.host.persistenceRotationError) return;
		if (this.host.expectedHeadId == null) {
			this.bufferUnpinnedFrame(rawMessage);
			return;
		}
		this.processPinnedMessage(rawMessage);
	}

	private bufferUnpinnedFrame(rawMessage: string): void {
		const frameBytes = Buffer.byteLength(rawMessage, 'utf8');
		if (frameBytes > MAX_HYDRA_WS_FRAME_BYTES || this._unpinnedBytes + frameBytes > MAX_UNPINNED_HISTORY_BUFFER_BYTES) {
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
		if (this.pageClosedBeforeHeadExisted(bufferedFrames)) {
			this._restartRequested = true;
			this.connection.invalidate(
				new HydraTransportError('Hydra history page closed before the head existed; restarting replay'),
			);
			return;
		}
		// Stopped on the failure counter, not on `_failed`. Rejecting a frame
		// invalidates the socket, whose close handler starts a fresh pass, and a
		// fresh pass clears `_failed` — synchronously, inside this loop. Reading
		// the flag therefore saw `false` immediately after a rejection and carried
		// on feeding the rest of the page into what was now a *new* pass: its
		// closing `Greetings` then installed an unsigned anchor and marked the
		// replay complete, reporting a verified history for a head whose signed
		// history had just been rejected.
		const failureGenerationAtStart = this._failureGeneration;
		for (const frame of bufferedFrames) {
			if (this._failureGeneration !== failureGenerationAtStart) break;
			this.processPinnedMessage(frame);
		}
	}

	/**
	 * Was this buffered page written by a node that had no head yet?
	 *
	 * Greetings closes a history page and states the node's status as it stood
	 * then, so an Idle one carrying no head id is proof rather than a violation —
	 * the same reading the live session already gives it, where returning to Idle
	 * is a legitimate rollback through Init rather than a protocol breach.
	 *
	 * Scoped to the flush deliberately. Frames are only buffered while no head is
	 * pinned, and nothing unpins one, so this cannot fire twice and the restart it
	 * asks for cannot loop. A pinned pass that reaches Idle is a different
	 * question — a head this service believes in that its node no longer sees —
	 * and still fails closed.
	 */
	private pageClosedBeforeHeadExisted(frames: readonly string[]): boolean {
		for (const frame of frames) {
			let message: unknown;
			try {
				message = parseBoundedJsonFrame(frame);
			} catch {
				// Malformed: let the normal pass report it with its own message.
				return false;
			}
			const envelope = messageSchema.safeParse(message);
			if (!envelope.success || envelope.data.tag !== 'Greetings') continue;
			if (envelope.data.headId != null || envelope.data.hydraHeadId != null) continue;
			const status = hydraHeadStatusSchema.safeParse(envelope.data.headStatus);
			if (status.success && status.data === HydraHeadStatus.Idle) return true;
		}
		return false;
	}

	private processPinnedMessage(rawMessage: string): void {
		try {
			const message = parseBoundedJsonFrame(rawMessage);
			this.host.assertPersistenceReplayIsSupported(message);
			const parsedEnvelope = messageSchema.parse(message);
			assertExpectedFrameHeadId(parsedEnvelope, this.host.expectedHeadId);
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
				'utxo' in message
			) {
				const parsedOpen = historyHeadIsOpenMessageSchema.parse(message);
				this.recordUnsignedLedgerAnchor(parsedOpen.headId, parsedOpen.utxo);
			}
			if (parsedEnvelope.tag === 'HeadIsFinalized' && hasFinalizedUtxoField(message)) {
				this.host.recordFinalizedFanout(message);
			}

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
			// flushed oldest-first, timestamp-attributed) was built for both.
			const settled = readDecommitSettled(parsedEnvelope.tag, message);
			if (settled) this.host.rememberReplayedDecommit(settled);

			// Before the snapshot that reflects it, always: the head reports the
			// request first, and the transaction it carries is what accounts for the
			// value change that snapshot signs.
			if (parsedEnvelope.tag === 'DecommitRequested') {
				this.rememberDecommitTransaction(decommitRequestedMessageSchema.parse(message).decommitTx);
			}

			if (parsedEnvelope.tag === 'SnapshotConfirmed') {
				this.reportSnapshotDrift(message);
				const parsedMessage = historySnapshotConfirmedMessageSchema.parse(message);
				assertExpectedFrameHeadId(parsedMessage, this.host.expectedHeadId);
				// Signed states and transaction transitions are verified progressively.
				// This avoids retaining the unbounded raw prefix emitted before Greetings.
				this.recordHistorySnapshot(parsedMessage);
				return;
			}

			if (parsedEnvelope.tag === 'Greetings') {
				this.host.verifyGreetingsPartyIdentity(message);
				const parsedHeadStatus = hydraHeadStatusSchema.safeParse(parsedEnvelope.headStatus);
				if (!parsedHeadStatus.success) {
					throw new HydraProtocolError('History Greetings frame has an invalid headStatus');
				}
				if ((this.host.expectedHeadId || this._verifiedSnapshot) && !suppliedHeadId) {
					throw new HydraProtocolError('Pinned Hydra history Greetings omitted its head identifier');
				}
				if (this._verifiedSnapshot && suppliedHeadId !== this._verifiedSnapshot.headId) {
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
				if (suppliedHeadId) this._sessionHeadId = suppliedHeadId;
				this._partyIdentityVerified = true;
				// Greetings authenticates the end marker, not the preceding transaction
				// metadata. A truncated page remains fail-closed until every retained
				// item has a durable cursor and a later full pass reaches this marker.
				this._complete = !this._truncated;
				if (this._complete) {
					this._error = undefined;
					this.ledger.trim();
				} else this.maybeRestartTruncated();
			}
		} catch (error) {
			this.fail(error);
		}
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
			entry.fields.some((field) => !this._reportedDriftFields.has(field)),
		);
		if (fresh.length === 0) return;
		for (const entry of fresh) for (const field of entry.fields) this._reportedDriftFields.add(field);
		const description = describeProtocolDrift(fresh);
		logger.warn(`[HydraNode] ${description}`);
		this.host.onProtocolDrift(description);
	}

	private rememberDecommitTransaction(transaction: HydraTransaction): void {
		const txId = transaction.txId?.toLowerCase();
		if (!txId) return;
		if (this._decommitTransactions.has(txId)) return;
		this._decommitTransactions.set(txId, transaction);
		if (this._decommitTransactions.size > MAX_TRACKED_DECOMMIT_TRANSACTIONS) {
			const oldest = this._decommitTransactions.keys().next().value;
			if (oldest !== undefined) this._decommitTransactions.delete(oldest);
		}
	}

	private recordHistorySnapshot(parsedMessage: ReturnType<typeof historySnapshotConfirmedMessageSchema.parse>): void {
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
		const verifiedSnapshot = verifyHydraSnapshot(parsedMessage, orderedKeys);
		const previousSnapshot = this._verifiedSnapshot;
		if (previousSnapshot && verifiedSnapshot.number <= previousSnapshot.number) {
			throw new HydraProtocolError('Hydra signed snapshot number replayed or regressed');
		}
		if (previousSnapshot == null) {
			if (verifiedSnapshot.number > 1 || parsedMessage.snapshot.confirmed.length > 0) {
				throw new HydraProtocolError(
					'Hydra history began with transactions or a snapshot gap and no independently verified predecessor',
				);
			}
			this._verifiedSnapshot = verifiedSnapshot;
			this._lastSequence = parsedMessage.seq;
			return;
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
		this._verifiedSnapshot = verifiedSnapshot;
		this._lastSequence = parsedMessage.seq;
		const protectedProducerTxIds = this.ledger.resolveProtectedSnapshotProducerTxIds(verifiedSnapshot);
		// Hydra 2.3 signatures authenticate only the TxOut multiset. Recording
		// tx ids/CBOR therefore additionally relies on this explicitly configured
		// local endpoint and the manager's per-action actor/body checks.
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
	}

	private truncatePage(): void {
		this._truncated = true;
		this._complete = false;
		this.maybeRestartTruncated();
	}
}
