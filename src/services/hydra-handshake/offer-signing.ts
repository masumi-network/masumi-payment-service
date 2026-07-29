/**
 * Signing and verifying head offers.
 *
 * The offering side signs the canonical payload with its Relation wallet; the
 * receiving side reconstructs the payload and verifies the signature **against
 * the counterparty wallet address recorded on that Relation**. Binding to the
 * address is what makes this authentication rather than a bare integrity
 * check — a valid signature from some other wallet proves nothing about who
 * sent it.
 */

import { MeshWallet, checkSignature } from '@meshsdk/core';
import stringify from 'canonical-json';
import { Network } from '@/generated/prisma/client';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import { decrypt } from '@/utils/security/encryption';
import { buildHydraHeadOfferPayload, type HydraHeadOfferPayloadInput } from './offer-payload';

export type OfferSignature = { signature: string; key: string };

export class OfferVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OfferVerificationError';
	}
}

/** Both sides hash the identical canonical payload, so any tampered field breaks verification. */
export function hashOfferPayload(input: HydraHeadOfferPayloadInput): string {
	return generateSHA256Hash(stringify(buildHydraHeadOfferPayload(input)));
}

export async function signHydraHeadOffer(
	input: HydraHeadOfferPayloadInput,
	wallet: { encryptedMnemonic: string; walletAddress: string; network: Network },
): Promise<OfferSignature> {
	const meshWallet = new MeshWallet({
		networkId: convertNetworkToId(wallet.network),
		key: { type: 'mnemonic', words: decrypt(wallet.encryptedMnemonic).split(' ') },
	});
	const signed = await meshWallet.signData(hashOfferPayload(input), wallet.walletAddress);
	return { signature: signed.signature, key: signed.key };
}

/**
 * Verify an inbound offer against the wallet this Relation is with.
 *
 * `checkSignature`'s third argument binds the signing key to that address, so
 * this single call proves both that the payload is untampered and that it came
 * from the counterparty rather than from anyone else holding a valid key.
 */
export async function verifyHydraHeadOffer(
	input: HydraHeadOfferPayloadInput,
	signature: OfferSignature,
	expectedSignerWalletAddress: string,
): Promise<void> {
	const hashed = hashOfferPayload(input);

	let signatureIsValid = false;
	try {
		signatureIsValid = await checkSignature(
			hashed,
			{ signature: signature.signature, key: signature.key },
			expectedSignerWalletAddress,
		);
	} catch (error) {
		throw new OfferVerificationError(`offer signature could not be checked: ${(error as Error).message}`);
	}

	if (!signatureIsValid) {
		throw new OfferVerificationError(
			'offer signature is invalid, or was not produced by the wallet recorded on this hydra relation',
		);
	}
}
