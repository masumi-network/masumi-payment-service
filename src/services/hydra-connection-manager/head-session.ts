/**
 * One Hydra Head's slot in the connection manager: everything that is true of
 * this process's relationship with one head, owned by one object.
 *
 * A slot spans transports. The current attachment (socket wrapper, provider,
 * and the durable owner epoch it was acquired under) comes and goes with each
 * connect/disconnect, but the reconnect timer, the serialization queues, the
 * transport generation and the two fences all deliberately outlive it — a
 * quarantine raised by a dying transport must still be standing when the next
 * one asks to attach. Before this class, that state lived in twelve parallel
 * `Map<headId, …>`s and nothing owned the invariant that they agreed.
 *
 * Nothing here is a cache of the database. Promises, timers and sockets cannot
 * be persisted; the two fences have durable twins written by the status
 * persistence path; and `initialize()` rebuilds every slot from the DB on
 * restart. The one durable value passing through is `ownerEpoch` — the fencing
 * token under which the attachment was acquired (see ADR-0014).
 */

import { logger } from '@masumi/payment-core/logger';
import { CustomHydraHead, HydraProvider } from '@/lib/hydra';
import type { HydraDatumApplyOutcome } from './hydra-datum-sync';

const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/** A live transport bound to this head, under one acquired owner epoch. */
export interface HeadAttachment {
	readonly head: CustomHydraHead;
	readonly provider: HydraProvider;
	/** The fencing token this attachment's durable writes must carry. */
	readonly ownerEpoch: bigint;
}

export class HeadSession {
	readonly hydraHeadId: string;

	private _attachment: HeadAttachment | null = null;
	private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private _reconnectAttempts = 0;
	private _connectWork: Promise<void> | null = null;
	private _transportGeneration = 0;
	private _controlQueue: Promise<boolean> | null = null;
	private _statusQueue: Promise<void> | null = null;
	private _txQueue: Promise<unknown> | null = null;
	private readonly _txWorkById = new Map<string, Promise<HydraDatumApplyOutcome>>();
	private _quarantinedHead: CustomHydraHead | null = null;
	private _revokedHead: CustomHydraHead | null = null;
	private _clockRefresher: ReturnType<typeof setInterval> | null = null;

	constructor(hydraHeadId: string) {
		this.hydraHeadId = hydraHeadId;
	}

	// ---- attachment ----------------------------------------------------------

	get attachment(): HeadAttachment | null {
		return this._attachment;
	}

	attach(attachment: HeadAttachment): void {
		this._attachment = attachment;
	}

	/**
	 * Drop the attachment if it is still this exact transport. Clears the status
	 * queue with it — queued frames from a torn-down transport were flushed by
	 * the caller before this — and releases a command revocation that named it,
	 * because that fence is instance-based and meaningless once the instance is
	 * gone; a newer attachment is unaffected either way.
	 */
	detachIfCurrent(head: CustomHydraHead): void {
		if (this._attachment?.head === head) {
			this._attachment = null;
			this._statusQueue = null;
		}
		if (this._revokedHead === head) {
			this._revokedHead = null;
		}
	}

	/**
	 * Whether this exact transport may still mutate durable state: it is the
	 * current attachment, the slot is not quarantined, and its commands were not
	 * revoked by a teardown already in flight.
	 */
	isMutationAllowed(head: CustomHydraHead): boolean {
		return this._attachment?.head === head && this._quarantinedHead === null && this._revokedHead !== head;
	}

	// ---- transport generation ------------------------------------------------

	/**
	 * Process-local acquisition fence: a connect captures the generation before
	 * its first await and refuses to publish a transport if it moved. Guards the
	 * window before an attachment exists, where the durable epoch cannot yet.
	 */
	get transportGeneration(): number {
		return this._transportGeneration;
	}

	bumpTransportGeneration(): void {
		this._transportGeneration += 1;
	}

	// ---- fences --------------------------------------------------------------

	/** The transport whose failed lifecycle persistence raised the quarantine. */
	get quarantinedHead(): CustomHydraHead | null {
		return this._quarantinedHead;
	}

	get isQuarantined(): boolean {
		return this._quarantinedHead !== null;
	}

	quarantine(failedHead: CustomHydraHead): void {
		this._quarantinedHead = failedHead;
	}

	clearQuarantine(): void {
		this._quarantinedHead = null;
	}

	/**
	 * Recovery reconnects clear the fence only once a *different* transport has
	 * durably re-observed the head's lifecycle; the failed one can never clear
	 * its own quarantine.
	 */
	clearQuarantineAfterReobservation(observingHead: CustomHydraHead): void {
		if (this._quarantinedHead !== null && this._quarantinedHead !== observingHead) {
			this._quarantinedHead = null;
		}
	}

	/**
	 * Revoke captured command/provider references before waiting for status
	 * drain or websocket shutdown during teardown.
	 */
	revokeCommands(head: CustomHydraHead): void {
		this._revokedHead = head;
	}

	// ---- reconnect policy ----------------------------------------------------

	/**
	 * Schedule one retry with exponential backoff. No-op while one is pending;
	 * the attempt counter survives across retries and resets on `clearReconnect`.
	 */
	scheduleReconnect(run: () => void): void {
		if (this._reconnectTimer) return;
		const attempt = this._reconnectAttempts;
		const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(attempt, 10));
		this._reconnectAttempts = attempt + 1;
		const timer = setTimeout(() => {
			this._reconnectTimer = null;
			run();
		}, delay);
		timer.unref?.();
		this._reconnectTimer = timer;
	}

	clearReconnect(): void {
		if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
		this._reconnectTimer = null;
		this._reconnectAttempts = 0;
	}

	// ---- head clock refresher ------------------------------------------------

	startClockRefresh(intervalMs: number, refresh: () => void): void {
		this.stopClockRefresh();
		refresh();
		const timer = setInterval(refresh, intervalMs);
		timer.unref?.();
		this._clockRefresher = timer;
	}

	stopClockRefresh(): void {
		if (this._clockRefresher) {
			clearInterval(this._clockRefresher);
			this._clockRefresher = null;
		}
	}

	// ---- serialization queues ------------------------------------------------

	/**
	 * Deduplicate concurrent connects: a second caller awaits the first's work
	 * rather than racing it.
	 */
	runConnect(op: () => Promise<void>): Promise<void> {
		const existing = this._connectWork;
		if (existing) return existing;
		const work = op();
		this._connectWork = work;
		void work
			.catch(() => undefined)
			.finally(() => {
				if (this._connectWork === work) this._connectWork = null;
			});
		return work;
	}

	/**
	 * Serialize a control operation (reconcile, disconnect, recovery) behind
	 * whatever control work is already queued. A predecessor's failure does not
	 * cancel successors.
	 */
	runControl(op: () => Promise<boolean>): Promise<boolean> {
		const previous = this._controlQueue ?? Promise.resolve(false);
		const work = previous.catch(() => false).then(op);
		this._controlQueue = work;
		void work
			.catch(() => false)
			.finally(() => {
				if (this._controlQueue === work) this._controlQueue = null;
			});
		return work;
	}

	/** Append lifecycle-status persistence work to this head's durable queue. */
	enqueueStatus(op: () => Promise<void>): void {
		const previous = this._statusQueue ?? Promise.resolve();
		const work = previous.catch(() => undefined).then(op);
		this._statusQueue = work;
		void work
			.catch(() => undefined)
			.finally(() => {
				if (this._statusQueue === work) this._statusQueue = null;
			});
	}

	/** Wait until every status frame already queued for this head is durable. */
	async flushStatus(): Promise<void> {
		while (true) {
			const queued = this._statusQueue;
			if (!queued) return;
			await queued.catch(() => undefined);
			if (this._statusQueue === queued) return;
		}
	}

	/**
	 * Run confirmed-transaction work serialized per head and deduplicated per
	 * transaction id: a frame replayed while its work is still in flight joins
	 * that work instead of re-running it.
	 */
	runTxConfirmed(txId: string, op: () => Promise<HydraDatumApplyOutcome>): Promise<HydraDatumApplyOutcome> {
		const existing = this._txWorkById.get(txId);
		if (existing) {
			logger.debug(`[HydraConnectionManager] Skipping duplicate TxConfirmed for ${txId}`);
			return existing;
		}
		const previous = this._txQueue ?? Promise.resolve();
		const work = previous.catch(() => undefined).then(op);
		this._txQueue = work;
		this._txWorkById.set(txId, work);
		void work
			.catch(() => undefined)
			.finally(() => {
				this._txWorkById.delete(txId);
				if (this._txQueue === work) this._txQueue = null;
			});
		return work;
	}
}
