import { describe, expect, it } from '@jest/globals';
import { buildHydraHeadInvitePayload, HYDRA_INVITE_PAYLOAD_VERSION } from './invite-payload';

const BASE = {
	nonce: 'nonce-1',
	expiresAt: '1700000000000',
	network: 'Preprod',
	issuerWalletAddress: 'addr_test1issuer',
	issuerWalletRole: 'Seller' as const,
	hydraVerificationKey: '5820aa',
	cardanoVerificationKey: '5820bb',
	advertise: '127.0.0.1:5001',
	exchangeUrl: 'http://127.0.0.1:18543/exchange',
	contestationPeriodSeconds: 220,
	depositPeriodSeconds: 3600,
	unsyncedPeriodSeconds: 1800,
	ledgerParamsHash: 'sha256:cc',
};

/**
 * A head carries payments in one direction: the buyer's wallet locks funds and
 * the seller's collects them. A buyer-to-buyer head opens perfectly well and
 * then routes nothing, with every payment falling back to L1 and no error to
 * explain it. The role therefore has to be part of what the issuer signs, so the
 * redeemer can be held to the other side of it.
 */
describe('the issuer role in the signed payload', () => {
	it('is covered by the signature', () => {
		const seller = buildHydraHeadInvitePayload(BASE);
		const buyer = buildHydraHeadInvitePayload({ ...BASE, issuerWalletRole: 'Buyer' });

		expect(JSON.stringify(seller)).not.toEqual(JSON.stringify(buyer));
		expect(seller.issuerWalletRole).toBe('Seller');
	});

	// Adding a field to a signed payload without moving the version would let an
	// older signer's invite be read under the new shape.
	it('came with a version bump', () => {
		expect(HYDRA_INVITE_PAYLOAD_VERSION).toBe('masumi.hydra.invite.v2');
		expect(buildHydraHeadInvitePayload(BASE).version).toBe(HYDRA_INVITE_PAYLOAD_VERSION);
	});

	// The canonical builder lists its keys explicitly so an unsigned field cannot
	// slip in. That only holds if the new field is actually in the output.
	it('is present in the canonical form', () => {
		expect(Object.keys(buildHydraHeadInvitePayload(BASE))).toContain('issuerWalletRole');
	});
});
