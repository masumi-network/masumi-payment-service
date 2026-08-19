/**
 * Signing and verifying head invites.
 *
 * The same mechanism the wire offer used, and for the same reason: binding the
 * signature to a wallet *address* via `checkSignature` is what makes this
 * authentication rather than a bare integrity check. A valid signature from
 * some other wallet proves nothing about who sent it.
 *
 * What differs is where the expected address comes from. An offer was verified
 * against a wallet already recorded on a Relation. An invite arrives from
 * someone we may have no Relation with, so the address is taken from the signed
 * payload itself and shown to an operator, who decides whether that wallet is
 * the counterparty they meant. The signature proves the payload came from the
 * holder of that address; only a human can say whether that address is the
 * right one.
 */

import { MeshWallet, checkSignature } from '@meshsdk/core';
import stringify from 'canonical-json';
import { Network } from '@/generated/prisma/client';
import { convertNetworkToId } from '@/utils/converter/network-convert';
import { generateSHA256Hash } from '@/utils/crypto';
import { decrypt } from '@/utils/security/encryption';
import {
	buildHydraHeadInvitePayload,
	buildHydraRedemptionPayload,
	type HydraHeadInvitePayloadInput,
	type HydraRedemptionPayloadInput,
} from './invite-payload';

export type InviteSignature = { signature: string; key: string };

export class InviteVerificationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'InviteVerificationError';
	}
}

export function hashInvitePayload(input: HydraHeadInvitePayloadInput): string {
	return generateSHA256Hash(stringify(buildHydraHeadInvitePayload(input)));
}

export function hashRedemptionPayload(input: HydraRedemptionPayloadInput): string {
	return generateSHA256Hash(stringify(buildHydraRedemptionPayload(input)));
}

async function signHash(
	hashed: string,
	wallet: { encryptedMnemonic: string; walletAddress: string; network: Network },
): Promise<InviteSignature> {
	const meshWallet = new MeshWallet({
		networkId: convertNetworkToId(wallet.network),
		key: { type: 'mnemonic', words: decrypt(wallet.encryptedMnemonic).split(' ') },
	});
	const signed = await meshWallet.signData(hashed, wallet.walletAddress);
	return { signature: signed.signature, key: signed.key };
}

export async function signHydraHeadInvite(
	input: HydraHeadInvitePayloadInput,
	wallet: { encryptedMnemonic: string; walletAddress: string; network: Network },
): Promise<InviteSignature> {
	return await signHash(hashInvitePayload(input), wallet);
}

export async function signHydraRedemption(
	input: HydraRedemptionPayloadInput,
	wallet: { encryptedMnemonic: string; walletAddress: string; network: Network },
): Promise<InviteSignature> {
	return await signHash(hashRedemptionPayload(input), wallet);
}

async function verifyAgainst(hashed: string, signature: InviteSignature, expectedAddress: string): Promise<void> {
	let valid = false;
	try {
		valid = await checkSignature(hashed, signature, expectedAddress);
	} catch (error) {
		throw new InviteVerificationError(`signature could not be checked: ${(error as Error).message}`);
	}
	if (!valid) {
		throw new InviteVerificationError('signature does not match the wallet it claims to be from');
	}
}

/**
 * Verify an invite against the wallet named inside it.
 *
 * Self-referential on purpose: the payload says who signed it, and this proves
 * the claim. It establishes authenticity, not authorisation — deciding whether
 * that wallet is a counterparty worth opening a Head with is the operator's
 * call, made with the registry identity shown alongside.
 */
export async function verifyHydraHeadInvite(
	input: HydraHeadInvitePayloadInput,
	signature: InviteSignature,
): Promise<void> {
	await verifyAgainst(hashInvitePayload(input), signature, input.issuerWalletAddress);
}

export async function verifyHydraRedemption(
	input: HydraRedemptionPayloadInput,
	signature: InviteSignature,
): Promise<void> {
	await verifyAgainst(hashRedemptionPayload(input), signature, input.redeemerWalletAddress);
}
