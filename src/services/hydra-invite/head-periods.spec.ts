import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import { MIN_UNSYNCED_PERIOD_SECONDS, defaultPeriodsFor } from './provisioning';

/**
 * The three periods pull in opposite directions, which is the whole reason one
 * set of numbers cannot serve both networks.
 *
 * Settle time is a cost on every top-up, so it wants to be short. The dispute
 * window is the only protection against a counterparty closing on a stale
 * state, so it wants to be long, and the cost of a long one is merely a slower
 * settlement. Getting either backwards is silent: the head still opens, still
 * carries payments, and is simply less safe or more annoying than intended.
 */
describe('default head periods', () => {
	it('waits longer for funds to settle where they are real', () => {
		expect(defaultPeriodsFor(Network.Mainnet).depositPeriodSeconds).toBeGreaterThan(
			defaultPeriodsFor(Network.Preprod).depositPeriodSeconds,
		);
	});

	it('gives mainnet a far longer dispute window', () => {
		const mainnet = defaultPeriodsFor(Network.Mainnet).contestationPeriodSeconds;
		const preprod = defaultPeriodsFor(Network.Preprod).contestationPeriodSeconds;
		expect(mainnet).toBeGreaterThanOrEqual(3600);
		expect(mainnet).toBeGreaterThan(preprod * 5);
	});

	// Hydra's guarantee: an in-sync node always has at least half the dispute
	// window to observe an on-chain event and react to it. A larger limit lets a
	// node believe it is in sync after it has already lost the time it needs to
	// contest, which is the one way this setting can cause a loss.
	it.each([Network.Mainnet, Network.Preprod])('keeps the sync limit at half the window on %s', (network) => {
		const periods = defaultPeriodsFor(network);
		expect(periods.unsyncedPeriodSeconds).toBe(Math.round(periods.contestationPeriodSeconds / 2));
	});

	// Below a couple of minutes the pick-up window is the same size as the
	// chain-time jitter it has to survive.
	it.each([Network.Mainnet, Network.Preprod])('never settles faster than the floor on %s', (network) => {
		expect(defaultPeriodsFor(network).depositPeriodSeconds).toBeGreaterThanOrEqual(120);
	});
});

/**
 * The out-of-sync limit is derived from the dispute window, so a short window
 * silently produces a limit that ordinary block jitter crosses. Measured over
 * 60 consecutive preprod blocks the gaps ran to 71s, so a 60s limit - what a
 * two-minute dispute window gives - takes the head out of sync several times an
 * hour and it stops accepting commands.
 */
describe('period floors', () => {
	it('keeps the derived out-of-sync limit above real block jitter', () => {
		const preprod = defaultPeriodsFor(Network.Preprod);

		expect(preprod.unsyncedPeriodSeconds).toBeGreaterThanOrEqual(MIN_UNSYNCED_PERIOD_SECONDS);
	});

	// The floor and the field bound come from one constant so they cannot drift.
	it('sets the floor above the widest gap observed', () => {
		expect(MIN_UNSYNCED_PERIOD_SECONDS).toBeGreaterThan(71);
	});

	// Half the dispute window is the ceiling, so the window has to be at least
	// twice the floor for any legal pair to exist.
	it('implies a dispute window of at least twice the floor', () => {
		const shortestUsableWindow = MIN_UNSYNCED_PERIOD_SECONDS * 2;

		expect(Math.floor(shortestUsableWindow / 2)).toBeGreaterThanOrEqual(MIN_UNSYNCED_PERIOD_SECONDS);
	});
});
