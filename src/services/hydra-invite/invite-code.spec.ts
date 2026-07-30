import { describe, expect, it } from '@jest/globals';
import { INVITE_CODE_PREFIX, decodeInviteCode, encodeInviteCode } from './invite-code';
import type { HydraHeadInvitePayloadInput } from './invite-payload';

const PAYLOAD: HydraHeadInvitePayloadInput = {
	nonce: 'nonce123456',
	expiresAt: '1785600000000',
	network: 'Preprod',
	issuerWalletAddress: 'addr_test1issuer',
	hydraVerificationKey: 'hvk',
	cardanoVerificationKey: '5820' + 'ab'.repeat(32),
	advertise: 'them.example.com:5101',
	exchangeUrl: 'https://them.example.com:8444/exchange',
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 300,
	unsyncedPeriodSeconds: 1800,
	ledgerParamsHash: 'sha256:abc',
};
const SIGNATURE = { signature: 'sig', key: 'key' };

describe('invite codes', () => {
	it('round-trips a payload unchanged', () => {
		const decoded = decodeInviteCode(encodeInviteCode({ payload: PAYLOAD, signature: SIGNATURE }));
		expect(decoded.payload).toEqual(PAYLOAD);
		expect(decoded.signature).toEqual(SIGNATURE);
	});

	// Round-tripping must be byte-exact, not merely field-equal: the signature
	// covers a canonical hash, so a field that changed type on the way through
	// would verify as forged.
	it('preserves a null ledgerParamsHash rather than dropping it', () => {
		const payload = { ...PAYLOAD, ledgerParamsHash: null };
		expect(decodeInviteCode(encodeInviteCode({ payload, signature: SIGNATURE })).payload.ledgerParamsHash).toBeNull();
	});

	it('survives being wrapped in whitespace by a mail client', () => {
		const code = encodeInviteCode({ payload: PAYLOAD, signature: SIGNATURE });
		expect(decodeInviteCode(`\n  ${code}\t\n`).payload.nonce).toBe(PAYLOAD.nonce);
	});

	it('carries a recognisable prefix', () => {
		expect(encodeInviteCode({ payload: PAYLOAD, signature: SIGNATURE }).startsWith(INVITE_CODE_PREFIX)).toBe(true);
	});

	it('tells an operator when they pasted something else entirely', () => {
		expect(() => decodeInviteCode('https://example.com/some-link')).toThrow(/masumi-hydra-invite/);
	});

	it('rejects a truncated code rather than half-reading it', () => {
		const code = encodeInviteCode({ payload: PAYLOAD, signature: SIGNATURE });
		expect(() => decodeInviteCode(code.slice(0, code.length - 20))).toThrow();
	});

	it.each([
		'nonce',
		'issuerWalletAddress',
		'hydraVerificationKey',
		'cardanoVerificationKey',
		'advertise',
		'exchangeUrl',
	])('refuses a code missing %s', (field) => {
		const payload: Record<string, unknown> = { ...PAYLOAD };
		delete payload[field];
		const code = `${INVITE_CODE_PREFIX}${Buffer.from(
			JSON.stringify({ payload, signature: SIGNATURE }),
			'utf8',
		).toString('base64url')}`;
		expect(() => decodeInviteCode(code)).toThrow(new RegExp(field));
	});

	// A period arriving as a string would still hash, but to a different value
	// than the issuer signed — so it must be caught as malformed, not as forged.
	it('refuses a period that is not a number', () => {
		const code = `${INVITE_CODE_PREFIX}${Buffer.from(
			JSON.stringify({ payload: { ...PAYLOAD, contestationPeriodSeconds: '220' }, signature: SIGNATURE }),
			'utf8',
		).toString('base64url')}`;
		expect(() => decodeInviteCode(code)).toThrow(/contestationPeriodSeconds/);
	});

	it('refuses a code with no signature', () => {
		const code = `${INVITE_CODE_PREFIX}${Buffer.from(JSON.stringify({ payload: PAYLOAD }), 'utf8').toString(
			'base64url',
		)}`;
		expect(() => decodeInviteCode(code)).toThrow(/payload or signature/);
	});

	it('refuses an implausibly large code without parsing it', () => {
		expect(() => decodeInviteCode(`${INVITE_CODE_PREFIX}${'A'.repeat(9000)}`)).toThrow(/not an invite code/);
	});
});
