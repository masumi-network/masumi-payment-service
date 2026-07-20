import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { headClockBehindCooldownMs, resolveHydraL2WindowOptions } from './l2-slot-context';

const ENV_KEYS = ['HYDRA_L2_SLOT_ZERO_TIME_MS', 'HYDRA_L2_SLOT_LENGTH_MS', 'HYDRA_L2_CURRENT_SLOT'] as const;

describe('resolveHydraL2WindowOptions', () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const k of ENV_KEYS) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] == null) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('prefers the env devnet override when set', () => {
		process.env.HYDRA_L2_SLOT_ZERO_TIME_MS = '1000';
		process.env.HYDRA_L2_SLOT_LENGTH_MS = '100';
		process.env.HYDRA_L2_CURRENT_SLOT = '50';
		const opts = resolveHydraL2WindowOptions({ getHeadClock: () => ({ chainTimeMs: 999999 }) });
		expect(opts.nowMs).toBe(1000 + 50 * 100);
		expect(opts.slotConfig).toBeDefined();
		expect(opts.beforeBufferMs).toBeDefined();
	});

	it('anchors nowMs to the provider head clock when no env override', () => {
		const opts = resolveHydraL2WindowOptions({ getHeadClock: () => ({ chainTimeMs: 1751959157000 }) });
		expect(opts.nowMs).toBe(1751959157000);
		expect(opts.slotConfig).toBeUndefined();
		expect(opts.beforeBufferMs).toBeUndefined();
	});

	it('returns empty options when neither env nor head clock is available', () => {
		const opts = resolveHydraL2WindowOptions({ getHeadClock: () => undefined });
		expect(opts).toEqual({});
	});
});

describe('headClockBehindCooldownMs', () => {
	it('returns 0 when the head clock passed the cooldown', () => {
		expect(headClockBehindCooldownMs({ nowMs: 2_000 }, 1_500n)).toBe(0);
	});

	it('returns the gap when the head clock is behind the cooldown', () => {
		expect(headClockBehindCooldownMs({ nowMs: 1_000 }, 1_500)).toBe(500);
	});

	it('accepts bigint cooldowns', () => {
		expect(headClockBehindCooldownMs({ nowMs: 1_000 }, 1_500n)).toBe(500);
	});

	it('returns 0 when there is no head anchor (wall-clock semantics unchanged)', () => {
		expect(headClockBehindCooldownMs({}, Date.now() - 60_000)).toBe(0);
	});
});
