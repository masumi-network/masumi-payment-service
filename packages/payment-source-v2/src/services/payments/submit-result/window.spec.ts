import { describe, expect, it } from '@jest/globals';
import { resolveSubmitResultConstrainAfterMs, SubmitResultWindowClosedError } from './service';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

/** Only the fields the window check reads. */
function datum(overrides: { resultTime: number; externalDisputeUnlockTime: number; resultHash?: string | null }) {
	return {
		resultTime: BigInt(overrides.resultTime),
		externalDisputeUnlockTime: BigInt(overrides.externalDisputeUnlockTime),
		resultHash: overrides.resultHash ?? null,
	} as never;
}

describe('resolveSubmitResultConstrainAfterMs', () => {
	it('uses the result deadline while it is still ahead', () => {
		const resultTime = NOW + 30 * MINUTE;

		expect(
			resolveSubmitResultConstrainAfterMs(datum({ resultTime, externalDisputeUnlockTime: NOW + 60 * MINUTE }), NOW),
		).toBe(BigInt(resultTime));
	});

	// Past the result deadline a result already on chain may still be rotated,
	// but only while the dispute window is open.
	it('falls back to the dispute deadline when a result is already on chain', () => {
		const externalDisputeUnlockTime = NOW + 30 * MINUTE;

		expect(
			resolveSubmitResultConstrainAfterMs(
				datum({ resultTime: NOW - MINUTE, externalDisputeUnlockTime, resultHash: 'ab'.repeat(32) }),
				NOW,
			),
		).toBe(BigInt(externalDisputeUnlockTime));
	});

	/**
	 * The case that blocked a queue.
	 *
	 * Typed rather than a bare Error so the caller can tell it apart from a
	 * failure worth retrying. A pass takes one request per wallet, so an
	 * always-failing request is picked again every round while everything behind
	 * it waits — until those deadlines pass too, one expiry cascading into the
	 * next. Parking it is the only thing that lets the rest through.
	 */
	it('reports a closed window as terminal, not as a retryable failure', () => {
		expect(() =>
			resolveSubmitResultConstrainAfterMs(
				datum({ resultTime: NOW - MINUTE, externalDisputeUnlockTime: NOW - MINUTE }),
				NOW,
			),
		).toThrow(SubmitResultWindowClosedError);
	});

	it('is terminal past the result deadline when nothing is on chain to rotate', () => {
		expect(() =>
			resolveSubmitResultConstrainAfterMs(
				datum({ resultTime: NOW - MINUTE, externalDisputeUnlockTime: NOW + 60 * MINUTE, resultHash: null }),
				NOW,
			),
		).toThrow(SubmitResultWindowClosedError);
	});
});
