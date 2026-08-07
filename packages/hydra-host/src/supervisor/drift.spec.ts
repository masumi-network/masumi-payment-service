import { describe, expect, it } from '@jest/globals';
import {
	DriftError,
	DriftThresholdError,
	DRIFT_RESTART_COOLDOWN_MS,
	DRIFT_STALL_MS,
	classifyDrift,
	driftBreachFields,
	shouldRestartForDrift,
	measureDrift,
	slotToChainTimeMs,
	validateDriftThresholds,
	type SlotConfig,
} from './drift.js';

// Preprod-shaped: 1s slots.
const CONFIG: SlotConfig = { zeroTime: 1_700_000_000_000, zeroSlot: 100_000, slotLength: 1_000 };

describe('slotToChainTimeMs', () => {
	it('maps a slot onto wall-clock time', () => {
		expect(slotToChainTimeMs(100_000, CONFIG)).toBe(1_700_000_000_000);
		expect(slotToChainTimeMs(100_060, CONFIG)).toBe(1_700_000_060_000);
	});

	it('rejects a nonsensical slot or slot length', () => {
		expect(() => slotToChainTimeMs(-1, CONFIG)).toThrow(DriftError);
		expect(() => slotToChainTimeMs(1.5, CONFIG)).toThrow(DriftError);
		expect(() => slotToChainTimeMs(100_000, { ...CONFIG, slotLength: 0 })).toThrow(/positive/);
	});
});

describe('measureDrift', () => {
	it('reports how far the follower is behind', () => {
		const sample = measureDrift(100_000, CONFIG, 1_700_000_180_000);
		expect(sample.driftMs).toBe(180_000);
		expect(sample.chainTimeMs).toBe(1_700_000_000_000);
	});

	// Small negative drift is clock skew, not health; clamping keeps the signal
	// one-directional so thresholds stay meaningful.
	it('clamps a node that appears slightly ahead to zero', () => {
		expect(measureDrift(100_010, CONFIG, 1_700_000_000_000).driftMs).toBe(0);
	});
});

describe('validateDriftThresholds', () => {
	const unsyncedPeriodMs = 1_800_000;

	it('accepts thresholds that fire before the node refuses input', () => {
		expect(() => validateDriftThresholds({ targetMs: 180_000, guardMs: 400_000 }, unsyncedPeriodMs)).not.toThrow();
	});

	// A guard at or beyond --unsynced-period is useless: by the time it fires,
	// the node is already rejecting every client input.
	it('rejects a guard at or beyond the unsynced period', () => {
		expect(() => validateDriftThresholds({ targetMs: 180_000, guardMs: unsyncedPeriodMs }, unsyncedPeriodMs)).toThrow(
			/must be below the node's unsynced period/,
		);
		expect(() =>
			validateDriftThresholds({ targetMs: 180_000, guardMs: unsyncedPeriodMs + 1 }, unsyncedPeriodMs),
		).toThrow(DriftThresholdError);
	});

	it('rejects a guard that is not above the target', () => {
		expect(() => validateDriftThresholds({ targetMs: 400_000, guardMs: 400_000 }, unsyncedPeriodMs)).toThrow(
			/greater than targetMs/,
		);
	});

	it('rejects non-positive thresholds', () => {
		expect(() => validateDriftThresholds({ targetMs: 0, guardMs: 400_000 }, unsyncedPeriodMs)).toThrow(
			DriftThresholdError,
		);
	});
});

describe('classifyDrift', () => {
	const thresholds = { targetMs: 180_000, guardMs: 400_000 };
	const sampleAt = (driftMs: number) => measureDrift(100_000, CONFIG, 1_700_000_000_000 + driftMs);

	it('classifies across the two thresholds', () => {
		expect(classifyDrift(sampleAt(0), thresholds)).toBe('Healthy');
		expect(classifyDrift(sampleAt(180_000), thresholds)).toBe('Healthy');
		expect(classifyDrift(sampleAt(180_001), thresholds)).toBe('Degraded');
		expect(classifyDrift(sampleAt(399_999), thresholds)).toBe('Degraded');
		expect(classifyDrift(sampleAt(400_000), thresholds)).toBe('Unsynced');
	});
});

describe('driftBreachFields', () => {
	const NOW = 1_700_000_000_000;

	it('opens a breach the first time drift passes the guard', () => {
		expect(driftBreachFields({}, { drift: 'Unsynced', driftSeconds: 400, nowMs: NOW })).toEqual({
			driftBreachSince: new Date(NOW).toISOString(),
			driftBreachSeconds: 400,
		});
	});

	// The whole point of the field: a node closing the gap is the catch-up loop
	// working, and restarting it there throws the progress away.
	it('re-anchors while the gap is closing, so a catching-up node never accumulates a stall', () => {
		const open = { driftBreachSince: new Date(NOW).toISOString(), driftBreachSeconds: 400 };
		expect(driftBreachFields(open, { drift: 'Unsynced', driftSeconds: 300, nowMs: NOW + 30_000 })).toEqual({
			driftBreachSince: new Date(NOW + 30_000).toISOString(),
			driftBreachSeconds: 300,
		});
	});

	it('leaves the breach untouched while drift is stuck, so its age accumulates', () => {
		const open = { driftBreachSince: new Date(NOW).toISOString(), driftBreachSeconds: 400 };
		expect(driftBreachFields(open, { drift: 'Unsynced', driftSeconds: 402, nowMs: NOW + 30_000 })).toEqual({});
	});

	// Preprod block gaps reach 69s unaided, so small movement is noise.
	it('treats a movement smaller than the epsilon as no progress', () => {
		const open = { driftBreachSince: new Date(NOW).toISOString(), driftBreachSeconds: 400 };
		expect(driftBreachFields(open, { drift: 'Unsynced', driftSeconds: 397, nowMs: NOW + 30_000 })).toEqual({});
	});

	it('clears the breach once drift is back under the guard', () => {
		const open = { driftBreachSince: new Date(NOW).toISOString(), driftBreachSeconds: 400 };
		expect(driftBreachFields(open, { drift: 'Healthy', driftSeconds: 10, nowMs: NOW + 30_000 })).toEqual({
			driftBreachSince: undefined,
			driftBreachSeconds: undefined,
		});
	});

	it('writes nothing when there is no breach and none was recorded', () => {
		expect(driftBreachFields({}, { drift: 'Healthy', driftSeconds: 10, nowMs: NOW })).toEqual({});
	});
});

describe('shouldRestartForDrift', () => {
	const NOW = 1_700_000_000_000;

	it('does not restart a node that has never breached', () => {
		expect(shouldRestartForDrift({}, NOW)).toBe(false);
	});

	it('does not restart before the stall window has elapsed', () => {
		const since = new Date(NOW - (DRIFT_STALL_MS - 1_000)).toISOString();
		expect(shouldRestartForDrift({ driftBreachSince: since }, NOW)).toBe(false);
	});

	it('restarts once the node has been stuck for the stall window', () => {
		const since = new Date(NOW - DRIFT_STALL_MS).toISOString();
		expect(shouldRestartForDrift({ driftBreachSince: since }, NOW)).toBe(true);
	});

	// A node that restarts and still cannot catch up must not restart every
	// couple of minutes forever.
	it('holds off inside the cooldown after a previous drift restart', () => {
		const since = new Date(NOW - DRIFT_STALL_MS).toISOString();
		const last = new Date(NOW - (DRIFT_RESTART_COOLDOWN_MS - 1_000)).toISOString();
		expect(shouldRestartForDrift({ driftBreachSince: since, lastDriftRestartAt: last }, NOW)).toBe(false);
	});

	it('allows another restart once the cooldown has passed', () => {
		const since = new Date(NOW - DRIFT_STALL_MS).toISOString();
		const last = new Date(NOW - DRIFT_RESTART_COOLDOWN_MS).toISOString();
		expect(shouldRestartForDrift({ driftBreachSince: since, lastDriftRestartAt: last }, NOW)).toBe(true);
	});

	it('ignores an unparseable timestamp rather than restarting on it', () => {
		expect(shouldRestartForDrift({ driftBreachSince: 'not-a-date' }, NOW)).toBe(false);
	});
});
