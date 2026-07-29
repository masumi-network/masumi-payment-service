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
