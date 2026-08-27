import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
	headClockBehindCooldownMs,
	getHydraL2SlotContext,
	resolveHydraL2EvidenceSlotConfig,
	resolveHydraL2WindowOptions,
} from './l2-slot-context';

const ENV_KEYS = [
	'HYDRA_L2_SLOT_ZERO_TIME_MS',
	'HYDRA_L2_SLOT_LENGTH_MS',
	'HYDRA_L2_CURRENT_SLOT',
	'HYDRA_L2_BEFORE_BUFFER_MS',
	'HYDRA_L2_AFTER_BUFFER_MS',
	'HYDRA_L2_VALIDITY_SLOT_BUFFER',
] as const;

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

	it.each([
		['fractional slot length', 'HYDRA_L2_SLOT_LENGTH_MS', '0.5'],
		['negative current slot', 'HYDRA_L2_CURRENT_SLOT', '-1'],
		['unsafe zero time', 'HYDRA_L2_SLOT_ZERO_TIME_MS', '9007199254740992'],
		['overflowing derived head time', 'HYDRA_L2_CURRENT_SLOT', '90071992547409'],
		['NaN before buffer', 'HYDRA_L2_BEFORE_BUFFER_MS', 'NaN'],
		['fractional after buffer', 'HYDRA_L2_AFTER_BUFFER_MS', '1.5'],
		['negative validity buffer', 'HYDRA_L2_VALIDITY_SLOT_BUFFER', '-1'],
	])('rejects a complete override with %s', (_label, key, value) => {
		process.env.HYDRA_L2_SLOT_ZERO_TIME_MS = '1000';
		process.env.HYDRA_L2_SLOT_LENGTH_MS = '100';
		process.env.HYDRA_L2_CURRENT_SLOT = '50';
		process.env[key] = value;

		expect(getHydraL2SlotContext()).toBeUndefined();
		expect(() => resolveHydraL2WindowOptions({ getHeadClock: () => ({ chainTimeMs: 999999 }) })).toThrow(
			/incomplete or invalid/i,
		);
	});
});

describe('resolveHydraL2EvidenceSlotConfig', () => {
	const saved: Record<string, string | undefined> = {};
	beforeEach(() => {
		for (const key of ENV_KEYS) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	});
	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (saved[key] == null) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it('uses the configured public-network timeline when no override is present', () => {
		expect(resolveHydraL2EvidenceSlotConfig('preprod')).toEqual(
			expect.objectContaining({ zeroTime: 1_655_769_600_000, zeroSlot: 86_400, slotLength: 1_000 }),
		);
	});

	it('uses the complete devnet slot timeline', () => {
		process.env.HYDRA_L2_SLOT_ZERO_TIME_MS = '1000';
		process.env.HYDRA_L2_SLOT_LENGTH_MS = '100';
		process.env.HYDRA_L2_CURRENT_SLOT = '50';
		expect(resolveHydraL2EvidenceSlotConfig('preprod')).toEqual(
			expect.objectContaining({ zeroTime: 1000, zeroSlot: 0, slotLength: 100 }),
		);
	});

	it('fails closed for a partial devnet slot override', () => {
		process.env.HYDRA_L2_SLOT_ZERO_TIME_MS = '1000';
		expect(resolveHydraL2EvidenceSlotConfig('preprod')).toBeNull();
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
