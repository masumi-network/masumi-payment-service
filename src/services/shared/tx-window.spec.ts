import { createTxWindow } from './tx-window';

// 1 slot == 1 second on all supported networks; timeBufferMs is 5 min (300 s),
// so the default window is roughly [now-301, now+330] in slots. These tests pin
// nowMs for determinism and assert relationships rather than absolute slots.
const NOW_MS = 1_700_000_000_000;
const FIVE_MIN_MS = 300_000;

describe('createTxWindow', () => {
	it('returns a valid (lower < upper) window with no deadline constraint', () => {
		const { invalidBefore, invalidAfter } = createTxWindow('preprod', { nowMs: NOW_MS });
		expect(invalidBefore).toBeLessThan(invalidAfter);
	});

	it('keeps the default window when the deadline is comfortably ahead (min strategy)', () => {
		const unconstrained = createTxWindow('preprod', { nowMs: NOW_MS });
		const constrained = createTxWindow('preprod', {
			nowMs: NOW_MS,
			constrainAfterMs: NOW_MS + 10 * FIVE_MIN_MS,
		});
		// A far-future deadline is looser than the default upper bound, so `min`
		// keeps the default.
		expect(constrained.invalidAfter).toBe(unconstrained.invalidAfter);
	});

	it('tightens invalidAfter below the default when the deadline is near', () => {
		const { invalidBefore, invalidAfter } = createTxWindow('preprod', {
			nowMs: NOW_MS,
			// ~90 s ahead: inside the default +330 s upper bound but still valid.
			constrainAfterMs: NOW_MS + 90_000,
		});
		const unconstrained = createTxWindow('preprod', { nowMs: NOW_MS });
		expect(invalidAfter).toBeLessThan(unconstrained.invalidAfter);
		expect(invalidBefore).toBeLessThan(invalidAfter);
	});

	it('throws when the deadline is already in the past (collapsed window)', () => {
		expect(() =>
			createTxWindow('preprod', {
				nowMs: NOW_MS,
				constrainAfterMs: NOW_MS - FIVE_MIN_MS,
			}),
		).toThrow(/validity range collapsed/);
	});

	it('accepts bigint deadline inputs without precision loss', () => {
		const asNumber = createTxWindow('preprod', {
			nowMs: NOW_MS,
			constrainAfterMs: NOW_MS + 10 * FIVE_MIN_MS,
		});
		const asBigint = createTxWindow('preprod', {
			nowMs: NOW_MS,
			constrainAfterMs: BigInt(NOW_MS + 10 * FIVE_MIN_MS),
		});
		expect(asBigint).toEqual(asNumber);
	});

	it('raises invalidBefore to satisfy a cooldown (constrainBeforeMs)', () => {
		const base = createTxWindow('preprod', { nowMs: NOW_MS });
		const withCooldown = createTxWindow('preprod', {
			nowMs: NOW_MS,
			// Cooldown 3 min ahead of now — later than the default now-5min anchor.
			constrainBeforeMs: NOW_MS + 3 * 60_000,
		});
		expect(withCooldown.invalidBefore).toBeGreaterThan(base.invalidBefore);
		expect(withCooldown.invalidBefore).toBeLessThan(withCooldown.invalidAfter);
	});
});
