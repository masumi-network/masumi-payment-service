import { describe, expect, it } from '@jest/globals';
import { MeshWallet } from '@meshsdk/core';
import { Network } from '@/generated/prisma/client';
import { hashOfferPayload, verifyHydraHeadOffer, type OfferSignature } from './offer-signing';
import type { HydraHeadOfferPayloadInput } from './offer-payload';

// Throwaway wallets, generated rather than hand-written: a mnemonic invented by
// hand fails its BIP39 checksum and the test would exercise nothing.
const COUNTERPARTY_WORDS = MeshWallet.brew() as string[];
const STRANGER_WORDS = MeshWallet.brew() as string[];

const OFFER: HydraHeadOfferPayloadInput = {
	hydraRelationId: 'rel-1',
	headSequence: 1,
	nonce: 'nonce-1',
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

function walletFor(words: string[]): { wallet: MeshWallet; address: Promise<string> } {
	const wallet = new MeshWallet({
		networkId: 0,
		key: { type: 'mnemonic', words },
	});
	return { wallet, address: wallet.getChangeAddress() };
}

async function sign(words: string[], input: HydraHeadOfferPayloadInput): Promise<OfferSignature & { address: string }> {
	const { wallet, address } = walletFor(words);
	const resolved = await address;
	const signed = await wallet.signData(hashOfferPayload(input), resolved);
	return { signature: signed.signature, key: signed.key, address: resolved };
}

describe('verifyHydraHeadOffer', () => {
	it('accepts an offer signed by the relation counterparty', async () => {
		const signed = await sign(COUNTERPARTY_WORDS, OFFER);
		await expect(verifyHydraHeadOffer(OFFER, signed, signed.address)).resolves.toBeUndefined();
	}, 30_000);

	// The property the whole handshake rests on: a technically valid signature
	// from anyone else must not open a head with us.
	it('rejects a valid signature from a wallet that is not the counterparty', async () => {
		const counterparty = await sign(COUNTERPARTY_WORDS, OFFER);
		const stranger = await sign(STRANGER_WORDS, OFFER);

		await expect(verifyHydraHeadOffer(OFFER, stranger, counterparty.address)).rejects.toThrow(
			/signature is invalid, or was not produced by the wallet/,
		);
	}, 30_000);

	// Every field is signed, so tampering breaks verification by construction
	// rather than needing a separate equality check per field.
	it('rejects an offer whose advertise address was altered in transit', async () => {
		const signed = await sign(COUNTERPARTY_WORDS, OFFER);
		const tampered = { ...OFFER, advertise: 'attacker.example.com:5001' };

		await expect(verifyHydraHeadOffer(tampered, signed, signed.address)).rejects.toThrow(/signature is invalid/);
	}, 30_000);

	it('rejects an offer replayed into a different head slot', async () => {
		const signed = await sign(COUNTERPARTY_WORDS, OFFER);
		const replayed = { ...OFFER, headSequence: OFFER.headSequence + 1 };

		await expect(verifyHydraHeadOffer(replayed, signed, signed.address)).rejects.toThrow(/signature is invalid/);
	}, 30_000);

	it('rejects a malformed signature rather than throwing raw', async () => {
		const signed = await sign(COUNTERPARTY_WORDS, OFFER);
		await expect(
			verifyHydraHeadOffer(OFFER, { signature: 'not-a-signature', key: signed.key }, signed.address),
		).rejects.toThrow(/offer signature/);
	}, 30_000);
});

describe('hashOfferPayload', () => {
	it('is stable and order-independent for identical content', () => {
		expect(hashOfferPayload(OFFER)).toBe(hashOfferPayload({ ...OFFER }));
	});

	it('differs when a signed field differs', () => {
		expect(hashOfferPayload(OFFER)).not.toBe(hashOfferPayload({ ...OFFER, nonce: 'other' }));
	});
});
