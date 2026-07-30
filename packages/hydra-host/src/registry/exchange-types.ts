/**
 * What the Host knows about an exchange.
 *
 * Deliberately less than the payment service knows. The Host never verifies a
 * signature: doing so would mean pulling Mesh and its CSL bindings into an
 * image whose whole point is to be small, and would drag this package into the
 * V1/V2 mesh pinning rules for no gain. The Host does the cheap checks — is
 * this a nonce I issued, is it unredeemed, is it unexpired, is this signer one
 * my operator has a relation with — and stores the signature verbatim for the
 * payment service to verify when it polls.
 *
 * That split is what keeps the Exchange Plane safe to expose: everything it can
 * do without cryptography is reversible, and everything irreversible waits for
 * a service that holds keys.
 */

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

/**
 * An invite that arrived from a counterparty for the operator to consider.
 *
 * Only accepted from a wallet on the allow-list, so this is not an open write
 * buffer: a stranger reaches the operator by pasting, where a human approves.
 */
export type InboundInviteRecord = {
	nonce: string;
	receivedAt: number;
	/** The signed payload, opaque here and verified by the payment service. */
	payload: string;
	signature: ExchangeSignature;
	issuerWalletAddress: string;
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
