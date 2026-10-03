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
import { isVerificationKeyCborHex } from '../keys.js';

/**
 * Ceilings for the values this module cannot check the shape of.
 *
 * Everything else here is validated against a grammar, which bounds its length
 * as a side effect. These three are free-form, and a redemption is written to
 * the persistence volume BEFORE the payment service verifies its signature, so
 * without a ceiling an invitee can store a body-sized string per invite. The
 * limits are far above any real value: a bech32 Cardano address is about 100
 * characters, and a COSE_Sign1 signature with its key is a few hundred.
 */
const MAX_WALLET_ADDRESS_LENGTH = 256;
const MAX_EXCHANGE_URL_LENGTH = 2048;
const MAX_SIGNATURE_FIELD_LENGTH = 4096;

/** A string that is present, non-empty, and within its ceiling. */
function isBoundedString(value: unknown, maxLength: number): value is string {
	return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

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
	// The keys are checked for shape, not only for type. They are written
	// verbatim into the `.vk` envelopes hydra-node reads, and this is the one
	// place a counterparty's material enters the Host — a redemption carrying
	// anything else produces a node that dies at startup on a parse error, with
	// the head already reserved and the operator left reading container logs.
	return (
		isBoundedString(candidate.walletAddress, MAX_WALLET_ADDRESS_LENGTH) &&
		typeof candidate.hydraVerificationKey === 'string' &&
		isVerificationKeyCborHex(candidate.hydraVerificationKey) &&
		typeof candidate.cardanoVerificationKey === 'string' &&
		isVerificationKeyCborHex(candidate.cardanoVerificationKey) &&
		typeof candidate.advertise === 'string' &&
		parsePeerAdvertise(candidate.advertise) !== null &&
		isBoundedString(candidate.exchangeUrl, MAX_EXCHANGE_URL_LENGTH)
	);
}

export function isExchangeSignature(value: unknown): value is ExchangeSignature {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const candidate = value as Partial<ExchangeSignature>;
	return (
		isBoundedString(candidate.signature, MAX_SIGNATURE_FIELD_LENGTH) &&
		isBoundedString(candidate.key, MAX_SIGNATURE_FIELD_LENGTH)
	);
}
