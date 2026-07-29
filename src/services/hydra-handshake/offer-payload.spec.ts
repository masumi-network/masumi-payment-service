import { describe, expect, it } from '@jest/globals';
import {
	buildHydraHeadOfferPayload,
	checkOfferFreshness,
	isOfferInitiator,
	type HydraHeadOfferPayloadInput,
} from './offer-payload';

const INPUT: HydraHeadOfferPayloadInput = {
	hydraRelationId: 'rel-1',
	headSequence: 3,
	nonce: 'nonce-abc',
	expiresAt: '1784856130000',
	network: 'Preprod',
	hydraVerificationKey: `5820${'ab'.repeat(32)}`,
	cardanoVerificationKey: `5820${'cd'.repeat(32)}`,
	advertise: 'hydra1.example.com:5001',
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 300,
	unsyncedPeriodSeconds: 1800,
	ledgerParamsHash: 'sha256:abc',
};

describe('buildHydraHeadOfferPayload', () => {
	it('is stable for identical input, so both sides hash the same bytes', () => {
		expect(JSON.stringify(buildHydraHeadOfferPayload(INPUT))).toBe(JSON.stringify(buildHydraHeadOfferPayload(INPUT)));
	});

	// Every field is signed, so tampering with any of them breaks verification by
	// construction rather than by a separate check.
	it('changes when any signed field changes', () => {
		const base = JSON.stringify(buildHydraHeadOfferPayload(INPUT));
		const mutations: Partial<HydraHeadOfferPayloadInput>[] = [
			{ hydraRelationId: 'rel-2' },
			{ headSequence: 4 },
			{ nonce: 'other' },
			{ expiresAt: '1' },
			{ network: 'Mainnet' },
			{ hydraVerificationKey: `5820${'ff'.repeat(32)}` },
			{ cardanoVerificationKey: `5820${'ee'.repeat(32)}` },
			{ advertise: 'evil.example.com:5001' },
			{ contestationPeriodSeconds: 221 },
			{ depositPeriodSeconds: 301 },
			{ unsyncedPeriodSeconds: 1801 },
			{ ledgerParamsHash: 'sha256:other' },
		];
		for (const mutation of mutations) {
			expect(JSON.stringify(buildHydraHeadOfferPayload({ ...INPUT, ...mutation }))).not.toBe(base);
		}
	});

	// The counterparty must configure this string verbatim: etcd checks a
	// member's advertised URL against the cluster entry.
	it('carries the advertise address the counterparty must use verbatim', () => {
		expect(buildHydraHeadOfferPayload(INPUT).advertise).toBe('hydra1.example.com:5001');
	});

	it('carries a null ledger hash rather than omitting the field', () => {
		expect(buildHydraHeadOfferPayload({ ...INPUT, ledgerParamsHash: null }).ledgerParamsHash).toBeNull();
	});
});

describe('isOfferInitiator', () => {
	// Both sides see themselves as "local", so the rule must be evaluable
	// identically by each without coordination.
	it('designates the lower-sorting wallet key as the proposer', () => {
		expect(isOfferInitiator('aaa', 'bbb')).toBe(true);
		expect(isOfferInitiator('bbb', 'aaa')).toBe(false);
	});

	it('agrees between the two sides for the same pair', () => {
		const [a, b] = ['f00d', '0bad'];
		expect(isOfferInitiator(a, b)).toBe(!isOfferInitiator(b, a));
	});

	it('refuses a relation whose two sides are the same wallet', () => {
		expect(() => isOfferInitiator('same', 'same')).toThrow(/same wallet on both sides/);
	});
});

describe('checkOfferFreshness', () => {
	it('accepts an offer inside its window', () => {
		expect(checkOfferFreshness(1_000, 999)).toEqual({ fresh: true });
	});

	it('rejects an offer at or past its expiry', () => {
		expect(checkOfferFreshness(1_000, 1_000)).toMatchObject({ fresh: false });
		expect(checkOfferFreshness(1_000, 1_001)).toMatchObject({ fresh: false, reason: 'offer has expired' });
	});

	it('rejects a malformed expiry rather than treating it as far future', () => {
		expect(checkOfferFreshness(Number.NaN, 0)).toMatchObject({ fresh: false });
		expect(checkOfferFreshness(1.5, 0)).toMatchObject({ fresh: false });
	});
});
