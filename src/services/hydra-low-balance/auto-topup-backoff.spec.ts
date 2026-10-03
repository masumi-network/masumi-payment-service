import { describe, expect, it } from '@jest/globals';
import { HydraTopupStatus } from '@/generated/prisma/client';
import {
	AUTO_TOPUP_BACKOFF_BASE_MS,
	AUTO_TOPUP_BACKOFF_MAX_MS,
	autoTopupBackoffMs,
	evaluateAutoTopupBackoff,
} from './auto-topup-backoff';

const NOW = new Date('2026-08-18T12:00:00.000Z');

function ago(ms: number): Date {
	return new Date(NOW.getTime() - ms);
}

describe('autoTopupBackoffMs', () => {
	it('doubles from the base and stops at the cap', () => {
		expect(autoTopupBackoffMs(0)).toBe(0);
		expect(autoTopupBackoffMs(1)).toBe(AUTO_TOPUP_BACKOFF_BASE_MS);
		expect(autoTopupBackoffMs(2)).toBe(AUTO_TOPUP_BACKOFF_BASE_MS * 2);
		expect(autoTopupBackoffMs(4)).toBe(AUTO_TOPUP_BACKOFF_BASE_MS * 8);
		expect(autoTopupBackoffMs(5)).toBe(AUTO_TOPUP_BACKOFF_MAX_MS);
		expect(autoTopupBackoffMs(50)).toBe(AUTO_TOPUP_BACKOFF_MAX_MS);
	});
});

describe('evaluateAutoTopupBackoff', () => {
	it('lets the first attempt through', () => {
		expect(evaluateAutoTopupBackoff([], NOW)).toEqual({ consecutiveFailures: 0, retryAt: null, blocked: false });
	});

	it('holds a rule whose last attempt failed a minute ago', () => {
		const backoff = evaluateAutoTopupBackoff([{ status: HydraTopupStatus.Failed, createdAt: ago(60_000) }], NOW);

		expect(backoff.blocked).toBe(true);
		expect(backoff.consecutiveFailures).toBe(1);
		expect(backoff.retryAt).toEqual(new Date(ago(60_000).getTime() + AUTO_TOPUP_BACKOFF_BASE_MS));
	});

	it('releases it once the wait has passed', () => {
		const backoff = evaluateAutoTopupBackoff(
			[{ status: HydraTopupStatus.Failed, createdAt: ago(AUTO_TOPUP_BACKOFF_BASE_MS + 1) }],
			NOW,
		);

		expect(backoff.blocked).toBe(false);
	});

	it('waits longer the more attempts in a row have failed', () => {
		const attempts = [
			{ status: HydraTopupStatus.Failed, createdAt: ago(11 * 60_000) },
			{ status: HydraTopupStatus.Failed, createdAt: ago(20 * 60_000) },
			{ status: HydraTopupStatus.Failed, createdAt: ago(30 * 60_000) },
		];

		expect(evaluateAutoTopupBackoff(attempts, NOW).blocked).toBe(true);
		expect(evaluateAutoTopupBackoff(attempts.slice(0, 1), NOW).blocked).toBe(false);
	});

	// A run is a run of failures. A top-up that landed says the participant, its
	// wallet and its node were all working since.
	it('does not count failures behind a settled attempt', () => {
		const backoff = evaluateAutoTopupBackoff(
			[
				{ status: HydraTopupStatus.Absorbed, createdAt: ago(10_000) },
				{ status: HydraTopupStatus.Failed, createdAt: ago(60_000) },
				{ status: HydraTopupStatus.Failed, createdAt: ago(120_000) },
			],
			NOW,
		);

		expect(backoff).toEqual({ consecutiveFailures: 0, retryAt: null, blocked: false });
	});

	it('holds rather than retries when the failure has no usable timestamp', () => {
		const backoff = evaluateAutoTopupBackoff([{ status: HydraTopupStatus.Failed, createdAt: new Date(NaN) }], NOW);

		expect(backoff).toEqual({ consecutiveFailures: 1, retryAt: null, blocked: true });
	});
	// `reconcileRecoveredHydraTopups` rotates `updatedAt` to now on every tick for
	// any deposit it cannot resolve, and a failed deposit keeps its hash so it
	// stays in that candidate set forever. Aged off that field, the newest failure
	// is always seconds old and auto top-up for the participant never resumes.
	it('is not held open by a row the reconciler keeps touching', () => {
		const attempt = {
			status: HydraTopupStatus.Failed,
			createdAt: ago(AUTO_TOPUP_BACKOFF_BASE_MS + 60_000),
			// What the sweep would have written a moment ago.
			updatedAt: NOW,
		};

		expect(evaluateAutoTopupBackoff([attempt], NOW).blocked).toBe(false);
	});
});
