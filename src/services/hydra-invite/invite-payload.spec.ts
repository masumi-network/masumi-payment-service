import { describe, expect, it } from '@jest/globals';
import stringify from 'canonical-json';
import {
	HYDRA_INVITE_PAYLOAD_VERSION,
	INVITE_TTL_MS,
	buildHydraHeadInvitePayload,
	buildHydraRedemptionPayload,
	checkInviteFreshness,
	type HydraHeadInvitePayloadInput,
} from './invite-payload';

const INPUT: HydraHeadInvitePayloadInput = {
	nonce: 'nonce123456',
	expiresAt: '1785600000000',
	network: 'Preprod',
	issuerWalletAddress: 'addr_test1issuer',
	hydraVerificationKey: 'hvk',
	cardanoVerificationKey: 'cvk',
	advertise: 'them.example.com:5101',
	exchangeUrl: 'https://them.example.com:8444/exchange',
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 300,
	unsyncedPeriodSeconds: 1800,
	ledgerParamsHash: 'sha256:abc',
};

describe('the invite payload', () => {
	it('is stable regardless of key order in the input', () => {
		const reordered = Object.fromEntries(Object.entries(INPUT).reverse()) as unknown as HydraHeadInvitePayloadInput;
		expect(stringify(buildHydraHeadInvitePayload(reordered))).toBe(stringify(buildHydraHeadInvitePayload(INPUT)));
	});

	it('carries a version, so a later field change is a rejected signature rather than a misread', () => {
		expect(buildHydraHeadInvitePayload(INPUT).version).toBe(HYDRA_INVITE_PAYLOAD_VERSION);
	});

	// The signature covers exactly these fields. A field present on the type but
	// missing here would travel unsigned, which is how a tampered advertise
	// address gets a counterparty pointed at the wrong node.
	it('signs every field the recipient acts on', () => {
		const built = buildHydraHeadInvitePayload(INPUT);
		for (const field of Object.keys(INPUT)) {
			expect(built).toHaveProperty(field);
		}
	});

	it.each([
		['advertise', 'attacker.example.com:5101'],
		['hydraVerificationKey', 'attacker-hvk'],
		['cardanoVerificationKey', 'attacker-cvk'],
		['exchangeUrl', 'https://attacker.example.com/exchange'],
		['issuerWalletAddress', 'addr_test1attacker'],
	])('changes when %s is tampered with', (field, value) => {
		const tampered = { ...INPUT, [field]: value };
		expect(stringify(buildHydraHeadInvitePayload(tampered))).not.toBe(stringify(buildHydraHeadInvitePayload(INPUT)));
	});
});

describe('the redemption payload', () => {
	const redemption = {
		nonce: 'nonce123456',
		network: 'Preprod',
		redeemerWalletAddress: 'addr_test1redeemer',
		hydraVerificationKey: 'hvk',
		cardanoVerificationKey: 'cvk',
		advertise: 'us.example.com:5001',
		exchangeUrl: 'https://us.example.com:8444/exchange',
	};

	// Tied to one invite: without the nonce inside the signature, a redemption
	// captured from one exchange could be replayed into another.
	it('binds to the invite nonce', () => {
		expect(buildHydraRedemptionPayload(redemption).nonce).toBe('nonce123456');
		expect(stringify(buildHydraRedemptionPayload({ ...redemption, nonce: 'other12345678' }))).not.toBe(
			stringify(buildHydraRedemptionPayload(redemption)),
		);
	});

	// Distinct version strings, so a redemption cannot be presented as an invite.
	it('cannot be confused with an invite payload', () => {
		expect(buildHydraRedemptionPayload(redemption).version).not.toBe(HYDRA_INVITE_PAYLOAD_VERSION);
	});
});

describe('checkInviteFreshness', () => {
	const now = 1_785_000_000_000;

	it('accepts an invite with time left', () => {
		expect(checkInviteFreshness(now + 60_000, now).fresh).toBe(true);
	});

	it('rejects one that has expired', () => {
		expect(checkInviteFreshness(now - 1, now)).toMatchObject({ fresh: false, reason: 'invite has expired' });
	});

	it('rejects one with no usable expiry', () => {
		expect(checkInviteFreshness(Number.NaN, now).fresh).toBe(false);
	});

	// An invite claiming to outlive anything this service issues is either from a
	// misconfigured peer or forged against a stale schema; either way it should
	// not hold a node for a year.
	it('rejects an implausibly distant expiry', () => {
		expect(checkInviteFreshness(now + INVITE_TTL_MS * 3, now)).toMatchObject({ fresh: false });
	});

	it('accepts one at the default ttl', () => {
		expect(checkInviteFreshness(now + INVITE_TTL_MS, now).fresh).toBe(true);
	});
});
