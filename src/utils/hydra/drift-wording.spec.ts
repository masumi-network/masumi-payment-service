/**
 * A node that has not started following the chain is not "1521.4 days behind".
 *
 * Drift comes from the `currentSlot` a node reports, converted through the
 * network's Shelley genesis constants. A follower that has not reached a chain
 * point reports slot 0, and on preprod (zeroSlot 86400 at 2022-06-21) that
 * converts to a moment before the network existed — so a node that had just
 * started was described to the operator as more than four years behind, which
 * reads as broken software rather than as a node that needs a few more seconds.
 */

import { describe, expect, it } from '@jest/globals';
import { formatDriftBehind, hasNoChainPoint, NO_CHAIN_POINT_THRESHOLD_SECONDS } from './drift-wording';

/** The exact gap a preprod node at slot 0 produced on the day this was found. */
const SLOT_ZERO_PREPROD_SECONDS = 1521.4 * 24 * 60 * 60;

describe('hasNoChainPoint', () => {
	it('recognises the slot-zero gap that started this', () => {
		expect(hasNoChainPoint(SLOT_ZERO_PREPROD_SECONDS)).toBe(true);
	});

	it('leaves a real catching-up gap alone', () => {
		expect(hasNoChainPoint(45)).toBe(false);
		expect(hasNoChainPoint(20 * 60)).toBe(false);
		expect(hasNoChainPoint(6 * 60 * 60)).toBe(false);
		// A node stopped for a week and restarted really is a week behind.
		expect(hasNoChainPoint(7 * 24 * 60 * 60)).toBe(false);
	});

	it('has nothing to say about an unknown gap', () => {
		expect(hasNoChainPoint(null)).toBe(false);
		expect(hasNoChainPoint(Number.NaN)).toBe(false);
		expect(hasNoChainPoint(Number.POSITIVE_INFINITY)).toBe(false);
	});
});

describe('formatDriftBehind', () => {
	it('refuses to put a number on a gap that is not a measurement', () => {
		expect(formatDriftBehind(SLOT_ZERO_PREPROD_SECONDS)).toBeNull();
		expect(formatDriftBehind(NO_CHAIN_POINT_THRESHOLD_SECONDS)).toBeNull();
	});

	it('rounds to the unit that answers "wait, or intervene?"', () => {
		expect(formatDriftBehind(45)).toBe('45 seconds');
		expect(formatDriftBehind(20 * 60)).toBe('20 minutes');
		expect(formatDriftBehind(3 * 60 * 60)).toBe('3.0 hours');
		expect(formatDriftBehind(400_000)).toBe('4.6 days');
	});

	// A node reported slightly ahead is clock skew, not "extra good".
	it('says nothing for a gap of zero or less', () => {
		expect(formatDriftBehind(0)).toBeNull();
		expect(formatDriftBehind(-5)).toBeNull();
	});
});
