import { describe, expect, it } from '@jest/globals';
import {
	DriftError,
	DriftThresholdError,
	classifyDrift,
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
