/**
 * Chain-follower drift measurement.
 *
 * On the Blockfrost backend the follower sleeps one block time and then
 * processes exactly one block, so it loses roughly 17s per minute with no
 * catch-up path (upstream cardano-scaling/hydra#2753). Once drift exceeds
 * `--unsynced-period` the node rejects every client input with
 * `RejectedInputBecauseUnsynced`, and only a restart clears it.
 *
 * Drift is read from the `Greetings` frame's `currentSlot` rather than by
 * parsing the node's stdout, so the supervisor never depends on log files. The
 * payment service already uses this technique to keep its head clock fresh.
 *
 * Deliberately computed here from that slot rather than taken from the node's
 * own `SyncedStatusReport.drift`, which looks like the more direct source:
 *
 *  - It is not reliably there. Hydra 2.3 does not stream `Tick` /
 *    `SyncedStatusReport` on a quiet head, so a probe holding an 8s budget
 *    would often see none. `Greetings` arrives on connect, every time.
 *  - It points the dependency the wrong way. This supervisor exists to judge a
 *    node that may be unhealthy; a wedged follower's self-reported drift is
 *    precisely the number that cannot be trusted. `currentSlot` is a claim
 *    about how far it believes it has got, which wall clock can falsify.
 *  - The arithmetic is not a reimplementation of anything. `slotToChainTimeMs`
 *    uses the network's Shelley genesis constants (see slot-config.ts), which
 *    are immutable historical facts, not configuration that can go stale.
 */

export type SlotConfig = {
	/** Wall-clock ms of `zeroSlot`. */
	zeroTime: number;
	zeroSlot: number;
	/** Milliseconds per slot. */
	slotLength: number;
};

export type DriftSample = {
	currentSlot: number;
	chainTimeMs: number;
	driftMs: number;
};

export type DriftVerdict = 'Healthy' | 'Degraded' | 'Unsynced';

export class DriftError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DriftError';
	}
}

export function slotToChainTimeMs(slot: number, config: SlotConfig): number {
	if (!Number.isSafeInteger(slot) || slot < 0) {
		throw new DriftError(`currentSlot must be a non-negative integer, received ${String(slot)}`);
	}
	if (!Number.isSafeInteger(config.slotLength) || config.slotLength <= 0) {
		throw new DriftError('slotLength must be a positive number of milliseconds');
	}
	return config.zeroTime + (slot - config.zeroSlot) * config.slotLength;
}

/**
 * Positive drift means the node is behind the wall clock. A node slightly
 * *ahead* is clamped to zero rather than reported as negative: a small negative
 * value just reflects clock skew between us and the chain, and treating it as
 * "extra good" would be meaningless.
 */
export function measureDrift(currentSlot: number, config: SlotConfig, nowMs: number): DriftSample {
	const chainTimeMs = slotToChainTimeMs(currentSlot, config);
	return {
		currentSlot,
		chainTimeMs,
		driftMs: Math.max(0, nowMs - chainTimeMs),
	};
}

export type DriftThresholds = {
	/** Drift below this is healthy. */
	targetMs: number;
	/** At or above this, restart. Must be below the node's unsynced period. */
	guardMs: number;
};

export class DriftThresholdError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DriftThresholdError';
	}
}

/**
 * Reject thresholds that cannot do their job. A guard at or above the node's
 * `--unsynced-period` would only ever fire *after* the node had already started
 * refusing input, which defeats the point of watching drift at all.
 */
export function validateDriftThresholds(thresholds: DriftThresholds, unsyncedPeriodMs: number): void {
	const { targetMs, guardMs } = thresholds;
	if (!Number.isSafeInteger(targetMs) || targetMs <= 0) {
		throw new DriftThresholdError('targetMs must be a positive number of milliseconds');
	}
	if (!Number.isSafeInteger(guardMs) || guardMs <= 0) {
		throw new DriftThresholdError('guardMs must be a positive number of milliseconds');
	}
	if (guardMs <= targetMs) {
		throw new DriftThresholdError('guardMs must be greater than targetMs');
	}
	if (guardMs >= unsyncedPeriodMs) {
		throw new DriftThresholdError(
			`guardMs (${guardMs}) must be below the node's unsynced period (${unsyncedPeriodMs}); ` +
				'otherwise the node starts rejecting input before the watchdog ever fires',
		);
	}
}

export function classifyDrift(sample: DriftSample, thresholds: DriftThresholds): DriftVerdict {
	if (sample.driftMs >= thresholds.guardMs) {
		return 'Unsynced';
	}
	if (sample.driftMs > thresholds.targetMs) {
		return 'Degraded';
	}
	return 'Healthy';
}

/** How long a node may sit above the guard without improving before a restart. */
export const DRIFT_STALL_MS = 120_000;
/** Minimum spacing between drift restarts, so a node that cannot catch up does not thrash. */
export const DRIFT_RESTART_COOLDOWN_MS = 600_000;
/** Improvement smaller than this is noise: preprod block gaps reach 69s on their own. */
const DRIFT_PROGRESS_EPSILON_SECONDS = 5;

type DriftBreachState = {
	driftBreachSince?: string;
	driftBreachSeconds?: number;
};

/**
 * Track how long the follower has been behind *without closing the gap*.
 *
 * Being behind is not itself a fault — a node that has just started is behind
 * and is busy fixing it, at roughly a block a second. What cannot fix itself is
 * being behind and standing still, which is where a Blockfrost-backed node ends
 * up once its startup catch-up has run: from then on it sleeps an average block
 * time before every block and can only ever track the tip.
 *
 * So the clock is reset by progress rather than by the verdict. A node closing
 * the gap re-anchors on every improvement and never accumulates a stall; one
 * that is stuck accumulates from the moment it first passed the guard.
 */
export function driftBreachFields(
	current: DriftBreachState,
	observation: { drift: DriftVerdict | null; driftSeconds: number | null; nowMs: number },
): DriftBreachState {
	const breached = observation.drift === 'Unsynced' && observation.driftSeconds !== null;
	if (!breached) {
		// Undefined rather than omitted: this has to clear the stored fields.
		return current.driftBreachSince === undefined ? {} : { driftBreachSince: undefined, driftBreachSeconds: undefined };
	}
	const seconds = observation.driftSeconds as number;
	const since = current.driftBreachSince;
	const anchor = current.driftBreachSeconds;
	const improving = anchor !== undefined && seconds <= anchor - DRIFT_PROGRESS_EPSILON_SECONDS;
	if (since === undefined || improving) {
		return { driftBreachSince: new Date(observation.nowMs).toISOString(), driftBreachSeconds: seconds };
	}
	return {};
}

/** Whether a stalled follower has been stalled long enough, and is allowed another restart. */
export function shouldRestartForDrift(
	record: { driftBreachSince?: string; lastDriftRestartAt?: string },
	nowMs: number,
): boolean {
	if (record.driftBreachSince === undefined) return false;
	const since = Date.parse(record.driftBreachSince);
	if (!Number.isFinite(since) || nowMs - since < DRIFT_STALL_MS) return false;
	if (record.lastDriftRestartAt !== undefined) {
		const last = Date.parse(record.lastDriftRestartAt);
		if (Number.isFinite(last) && nowMs - last < DRIFT_RESTART_COOLDOWN_MS) return false;
	}
	return true;
}

/**
 * Where the guard sits inside the node's own unsynced period.
 *
 * The guard exists to restart a node that is about to stop accepting commands,
 * so it sits just inside the node's unsynced period.
 *
 * It was six tenths, which was wrong in a way only a live node showed: the
 * Blockfrost backend's own steady-state drift on this rig is 120-250s against a
 * 150s unsynced period, so a 90s guard put a perfectly serviceable node in
 * permanent breach. Drift then PLATEAUS rather than improving, the
 * progress re-anchor never fires, and the node was restarted once per cooldown
 * forever — throwing away catch-up each time. The guard has to mean "about to
 * be unusable", not "some fraction of the way there".
 */
const GUARD_FRACTION_OF_UNSYNCED = 0.95;
/** Degraded is advisory; half the guard is enough to separate it from healthy. */
const TARGET_FRACTION_OF_GUARD = 0.5;

/**
 * Drift thresholds for one node, from that node's own unsynced period.
 *
 * Derived rather than configured because the value they must stay below is
 * per-node — it is signed into the invite that opened the head — while any
 * configured threshold is per-host. A host default that suits an 1800s node is
 * simply wrong for a 150s one, and the mismatch is silent: the validation warns
 * on every tick and the invalid value is used anyway, so a guard of 400s sat
 * 250s ABOVE the point its node had already stopped accepting commands, and
 * could never fire in time.
 */
export function deriveDriftThresholds(unsyncedPeriodMs: number): DriftThresholds {
	const guardMs = Math.round(unsyncedPeriodMs * GUARD_FRACTION_OF_UNSYNCED);
	return { guardMs, targetMs: Math.round(guardMs * TARGET_FRACTION_OF_GUARD) };
}

/**
 * The thresholds to use, preferring an operator's explicit ones where they work.
 *
 * An override is honoured only while it still fires before the node refuses
 * input. One that does not is the exact misconfiguration this derivation
 * exists to remove, so the derived value wins rather than the operator's — a
 * guard that cannot fire in time is not a preference, it is a broken watchdog.
 */
export function resolveDriftThresholds(unsyncedPeriodMs: number, override?: Partial<DriftThresholds>): DriftThresholds {
	const derived = deriveDriftThresholds(unsyncedPeriodMs);
	const guardMs = override?.guardMs;
	if (guardMs === undefined || guardMs <= 0 || guardMs >= unsyncedPeriodMs) return derived;
	const overrideTarget = override?.targetMs;
	const targetMs =
		overrideTarget !== undefined && overrideTarget > 0 && overrideTarget < guardMs
			? overrideTarget
			: Math.round(guardMs * TARGET_FRACTION_OF_GUARD);
	return { guardMs, targetMs };
}
