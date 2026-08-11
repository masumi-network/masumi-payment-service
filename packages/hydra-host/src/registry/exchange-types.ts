/**
 * What the Host knows about an exchange.
 *
 * Deliberately less than the payment service knows. The Host never verifies a
 * signature: doing so would mean pulling Mesh and its CSL bindings into an
 * image whose whole point is to be small. The Host instead accepts redemption
 * only for an issued, unspent, unexpired nonce, validates every value it later
 * passes to another parser, and stores the signature for the payment service to
 * verify when it polls.
 *
 * That split is what keeps the Exchange Plane safe to expose: everything it can
 * do without cryptography is reversible, and everything irreversible waits for
 * a service that holds keys.
 */

import { parsePeerAdvertise } from '../peer-address.js';

/** Public material one side contributes to a head. */
export type ExchangeMaterial = {
	walletAddress: string;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
	advertise: string;
	/** Where this side redeems invites, so the other can reach it next time. */
	exchangeUrl: string;
};

export type ExchangeSignature = {
	signature: string;
	key: string;
};

/**
 * An invite this Host will honour, registered by the owning payment service
 * when it mints one.
 *
 * `hostNodeId` is the reservation: that node exists, holds a peer port, and
 * cannot boot until a redemption supplies its peer.
 */
export type InviteRecord = {
	nonce: string;
	hostNodeId: string;
	/** Epoch millis. Past this the reservation is released. */
	expiresAt: number;
	issuedAt: number;
	/** Filled by the redemption. Null while the invite is outstanding. */
	redeemedAt: number | null;
	redeemer: ExchangeMaterial | null;
	redeemerSignature: ExchangeSignature | null;
	/** Set when the Host could not start the node after redemption. */
	startError: string | null;
};

export function isExchangeMaterial(value: unknown): value is ExchangeMaterial {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<ExchangeMaterial>;
	return (
		typeof candidate.walletAddress === 'string' &&
		typeof candidate.hydraVerificationKey === 'string' &&
		typeof candidate.cardanoVerificationKey === 'string' &&
		typeof candidate.advertise === 'string' &&
		parsePeerAdvertise(candidate.advertise) !== null &&
		typeof candidate.exchangeUrl === 'string'
	);
}

export function isExchangeSignature(value: unknown): value is ExchangeSignature {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<ExchangeSignature>;
	return typeof candidate.signature === 'string' && typeof candidate.key === 'string';
}
