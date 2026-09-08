import { describe, expect, it } from '@jest/globals';
import { Network } from '@/generated/prisma/client';
import {
	DEFAULT_UNSYNCED_PERIOD_CAP_SECONDS,
	MIN_UNSYNCED_PERIOD_SECONDS,
	defaultPeriodsFor,
	defaultUnsyncedPeriodFor,
	periodsFromInvite,
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
		expect(periods.unsyncedPeriodSeconds).toBeLessThanOrEqual(Math.floor(periods.contestationPeriodSeconds / 2));
	});

	// That ceiling is the largest safe value, not the one to ship. Sitting on it
	// meant a mainnet head signed payments for two and a half days without
	// seeing a block, which is precisely what hydra's own documentation warns
	// against.
	it.each([Network.Mainnet, Network.Preprod])('does not default to the ceiling on %s', (network) => {
		const periods = defaultPeriodsFor(network);
		expect(periods.unsyncedPeriodSeconds).toBe(DEFAULT_UNSYNCED_PERIOD_CAP_SECONDS);
		expect(periods.unsyncedPeriodSeconds).toBeLessThan(Math.floor(periods.contestationPeriodSeconds / 2));
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

	// hydra-node 2.4's --deposit-activation. Set equal to the deposit period so
	// 2.4.1's usable-from (`deposit + activation`) and absorb-by
	// (`deposit + activation + DP`) land on exactly the moments 2.3.0 already
	// proved out (`deposit + DP` and `deposit + 2·DP`); upstream's own 3600s
	// default would push a preprod deposit's usable-from from +10 min to +60 min.
	it('sets deposit activation equal to the deposit period on both networks', () => {
		expect(defaultPeriodsFor(Network.Preprod).depositActivationSeconds).toBe(600);
		expect(defaultPeriodsFor(Network.Mainnet).depositActivationSeconds).toBe(1200);
		expect(defaultPeriodsFor(Network.Preprod).depositActivationSeconds).toBe(
			defaultPeriodsFor(Network.Preprod).depositPeriodSeconds,
		);
		expect(defaultPeriodsFor(Network.Mainnet).depositActivationSeconds).toBe(
			defaultPeriodsFor(Network.Mainnet).depositPeriodSeconds,
		);
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

/**
 * Both sides of a head must derive the SAME deposit activation, and neither
 * side exchanges it — the invite deliberately does not carry it, because it is
 * a per-node local setting.
 *
 * That works only while activation is derived from the deposit period both
 * sides already agree on. Deriving it from the redeemer's own network default
 * instead is correct exactly when the issuer used the default too, and silently
 * wrong otherwise: each node evaluates a deposit's absorb window
 * `[created + activation, deadline - depositPeriod]` against its own local
 * activation, so mismatched values shrink the overlap to nothing and no deposit
 * can ever be co-signed. Nothing reports it — both sides' `usableFrom` and
 * `absorbBy` derive from the deadline and keep looking normal.
 */
describe('periods a redeemed invite opens its head with', () => {
	const issuerOverrode = {
		contestationPeriodSeconds: 12 * 3600,
		// The public API's floor (min 300), and deliberately NOT the preprod
		// default of 600 — the case where issuer and redeemer defaults diverge.
		depositPeriodSeconds: 300,
		unsyncedPeriodSeconds: 1800,
	};

	it('takes activation from the ISSUER\'s deposit period, not the local default', () => {
		expect(periodsFromInvite(issuerOverrode).depositActivationSeconds).toBe(300);
		expect(periodsFromInvite(issuerOverrode).depositActivationSeconds).not.toBe(
			defaultPeriodsFor(Network.Preprod).depositActivationSeconds,
		);
	});

	it('keeps activation equal to the deposit period for any issuer choice', () => {
		for (const depositPeriodSeconds of [300, 600, 1200, 86_400]) {
			const periods = periodsFromInvite({ ...issuerOverrode, depositPeriodSeconds });
			expect(periods.depositActivationSeconds).toBe(periods.depositPeriodSeconds);
		}
	});

	it('carries the issuer\'s other periods through untouched', () => {
		const periods = periodsFromInvite(issuerOverrode);
		expect(periods.contestationPeriodSeconds).toBe(issuerOverrode.contestationPeriodSeconds);
		expect(periods.depositPeriodSeconds).toBe(issuerOverrode.depositPeriodSeconds);
		expect(periods.unsyncedPeriodSeconds).toBe(issuerOverrode.unsyncedPeriodSeconds);
	});
});
