import { describe, expect, it } from '@jest/globals';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { MINIMUM_WITHDRAWABLE_LOVELACE, reasonHeadIsNotDone } from './withdraw';

/**
 * Sweeping a node's fuel early is the expensive mistake, not sweeping it late.
 *
 * The node still owes a Close, possibly a Contest and a Fanout, and one that
 * cannot pay for its Fanout leaves the head's committed funds behind a
 * contestation deadline. Stranding a few ADA is the cheaper failure by a wide
 * margin, so every non-final state has to refuse.
 */
describe('reasonHeadIsNotDone', () => {
	it('allows a final head', () => {
		expect(reasonHeadIsNotDone(HydraHeadStatus.Final)).toBeNull();
	});

	// A participant with no head at all is an abandoned reservation — its node
	// will never owe anything, so its fuel is free to come back.
	it('allows a participant with no head', () => {
		expect(reasonHeadIsNotDone(undefined)).toBeNull();
	});

	it.each([
		HydraHeadStatus.Idle,
		HydraHeadStatus.Initializing,
		HydraHeadStatus.Open,
		HydraHeadStatus.Closed,
		HydraHeadStatus.FanoutPossible,
	])('refuses while the head is %s', (status) => {
		expect(reasonHeadIsNotDone(status)).toContain(status);
	});

	// FanoutPossible is the one worth stating outright: the head is over in
	// every sense except that nobody has paid for the fanout yet.
	it('names what the node still has to pay for', () => {
		expect(reasonHeadIsNotDone(HydraHeadStatus.FanoutPossible)).toMatch(/fanning out/);
	});
});

describe('the dust floor', () => {
	// The sweep pays its own fee out of what it sweeps, so below this it turns a
	// small loss into a slightly larger one.
	it('is above a typical transaction fee', () => {
		expect(MINIMUM_WITHDRAWABLE_LOVELACE).toBeGreaterThan(1_000_000n);
	});
});
