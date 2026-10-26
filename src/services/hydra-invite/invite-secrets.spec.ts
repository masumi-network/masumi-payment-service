import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/config', () => ({
	CONFIG: { ENCRYPTION_KEY: 'local-test-key-for-invite-secrets' },
}));

const { hashInviteNonce, revealInviteNonce, revealInviteSignature, sealInviteNonce, sealInviteSignature } =
	await import('./invite-secrets');

describe('Hydra invite secrets', () => {
	it('stores only encrypted bearer material while keeping a stable equality index', () => {
		const nonce = 'nonce-0123456789abcdefghijklmn';
		const signature = 'issuer-signature';
		const first = sealInviteNonce(nonce);
		const second = sealInviteNonce(nonce);
		const issuerSignature = sealInviteSignature(signature);

		expect(first.nonce).not.toContain(nonce);
		expect(issuerSignature).not.toContain(signature);
		expect(first.nonce).not.toBe(second.nonce);
		expect(first.nonceHash).toBe(second.nonceHash);
		expect(first.nonceHash).toBe(hashInviteNonce(nonce));
		expect(revealInviteNonce(first)).toBe(nonce);
		expect(revealInviteSignature({ ...first, issuerSignature })).toBe(signature);
	});

	it('rejects an encrypted nonce whose lookup hash was changed', () => {
		const stored = sealInviteNonce('single-use-nonce');
		expect(() => revealInviteNonce({ ...stored, nonceHash: hashInviteNonce('other-nonce') })).toThrow(/does not match/);
	});

	it('reads an unmigrated row only during the startup backfill', () => {
		expect(revealInviteNonce({ nonce: 'legacy-nonce', nonceHash: null })).toBe('legacy-nonce');
		expect(revealInviteSignature({ issuerSignature: 'legacy-signature', nonceHash: null })).toBe('legacy-signature');
	});
});
