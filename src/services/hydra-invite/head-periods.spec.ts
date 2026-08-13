import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import {
	DEFAULT_UNSYNCED_PERIOD_CAP_SECONDS,
	MIN_UNSYNCED_PERIOD_SECONDS,
	defaultPeriodsFor,
	defaultUnsyncedPeriodFor,
} from './provisioning';

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
	it.each([Network.Mainnet, Network.Preprod])('stays under half the window on %s', (network) => {
		const periods = defaultPeriodsFor(network);
		expect(periods.unsyncedPeriodSeconds).toBeLessThanOrEqual(
			Math.floor(periods.contestationPeriodSeconds / 2),
		);
	});

	// That ceiling is the largest safe value, not the one to ship. Sitting on it
	// meant a mainnet head signed payments for two and a half days without
	// seeing a block, which is precisely what hydra's own documentation warns
	// against.
	it.each([Network.Mainnet, Network.Preprod])('does not default to the ceiling on %s', (network) => {
		const periods = defaultPeriodsFor(network);
		expect(periods.unsyncedPeriodSeconds).toBe(DEFAULT_UNSYNCED_PERIOD_CAP_SECONDS);
		expect(periods.unsyncedPeriodSeconds).toBeLessThan(
			Math.floor(periods.contestationPeriodSeconds / 2),
		);
	});

	// Blind signing is the exposure, and it is the same exposure on a testnet:
	// preprod is where a backend that stalls for an hour has to be discovered.
	it('caps blind signing the same on both networks', () => {
		expect(defaultPeriodsFor(Network.Mainnet).unsyncedPeriodSeconds).toBe(
			defaultPeriodsFor(Network.Preprod).unsyncedPeriodSeconds,
		);
	});

	// A half-hour gap in block production runs about e^-90 with Cardano's 20s
	// mean, so what this actually tolerates is a stalled chain backend.
	it('outlasts any real block gap by a wide margin', () => {
		expect(DEFAULT_UNSYNCED_PERIOD_CAP_SECONDS).toBeGreaterThan(71 * 20);
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

	/**
	 * The cap only applies where there is room for it. A head configured with a
	 * short dispute window still has to derive a pair the orchestrator will
	 * accept — under the ceiling it enforces, above the floor block jitter
	 * crosses — or the default itself becomes a 400.
	 */
	it.each([
		[300, 150],
		[600, 300],
		[3600, 1800],
		[12 * 3600, DEFAULT_UNSYNCED_PERIOD_CAP_SECONDS],
		[5 * 24 * 3600, DEFAULT_UNSYNCED_PERIOD_CAP_SECONDS],
	])('derives a legal limit for a %ss dispute window', (contestation, expected) => {
		const derived = defaultUnsyncedPeriodFor(contestation);

		expect(derived).toBe(expected);
		expect(derived).toBeLessThanOrEqual(Math.floor(contestation / 2));
		expect(derived).toBeGreaterThanOrEqual(MIN_UNSYNCED_PERIOD_SECONDS);
	});
});
