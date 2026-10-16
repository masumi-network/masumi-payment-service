/**
 * Checking a redemption's signature before its nonce is spent.
 *
 * Redeeming is terminal: once a nonce is marked redeemed it can never open a
 * head again. If the Host spent it on a signature it had not checked, anyone
 * who saw the nonce could burn the invite with a forged body. So the Host runs
 * the same `checkSignature` the payment service runs at adoption, over the same
 * bytes, and refuses before anything is written.
 *
 * What this does not do: a leaked invite can still be redeemed by whoever holds
 * it, signing with their own wallet. The signature proves who redeemed, not
 * that they were the intended recipient.
 *
 * The payload is rebuilt here rather than imported, because this package builds
 * standalone inside its container. A parity spec on the service side keeps the
 * two builders byte-identical.
 */

import { createHash } from 'node:crypto';
import { checkSignature } from '@meshsdk/core-cst';
import stringify from 'canonical-json';
import type { HostConfig } from '../config.js';
import type { ExchangeMaterial, ExchangeSignature } from './exchange-types.js';

/** Must match `HYDRA_REDEMPTION_PAYLOAD_VERSION` in the payment service. */
export const HYDRA_REDEMPTION_PAYLOAD_VERSION = 'masumi.hydra.redemption.v1';

export type RedemptionNetwork = 'Preprod' | 'Mainnet';

/** The payment service signs the Prisma `Network` enum value, not the Host's lowercase config value. */
export function redemptionNetwork(network: HostConfig['network']): RedemptionNetwork {
	return network === 'mainnet' ? 'Mainnet' : 'Preprod';
}

/** SHA-256 hex of the canonical redemption payload: the string the redeemer's wallet signed. */
export function hashRedemptionPayload(nonce: string, network: RedemptionNetwork, redeemer: ExchangeMaterial): string {
	const payload = {
		version: HYDRA_REDEMPTION_PAYLOAD_VERSION,
		nonce,
		network,
		redeemerWalletAddress: redeemer.walletAddress,
		hydraVerificationKey: redeemer.hydraVerificationKey,
		cardanoVerificationKey: redeemer.cardanoVerificationKey,
		advertise: redeemer.advertise,
		exchangeUrl: redeemer.exchangeUrl,
	};
	return createHash('sha256').update(stringify(payload)).digest('hex');
}

/**
 * True only when `signature` is a valid signature over this redemption by the
 * key behind `redeemer.walletAddress`.
 *
 * Never throws: a body that cannot even be parsed is as unverified as one that
 * parses and fails, and both must leave the nonce untouched.
 */
export async function verifyRedemptionSignature(
	nonce: string,
	network: RedemptionNetwork,
	redeemer: ExchangeMaterial,
	signature: ExchangeSignature,
): Promise<boolean> {
	try {
		return await checkSignature(hashRedemptionPayload(nonce, network, redeemer), signature, redeemer.walletAddress);
	} catch {
		return false;
	}
}
