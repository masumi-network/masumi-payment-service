/**
 * The signed payload two operators exchange to agree a Hydra Head.
 *
 * A node serves exactly one Head, so every Head needs fresh keys, a fresh peer
 * port and a fresh etcd cluster config — and `--peer`,
 * `--hydra-verification-key` and `--initial-cluster` are all *startup*
 * configuration. Both sides must therefore agree the whole cluster before
 * either node boots, which makes this exchange a precondition for every Head
 * rather than a one-off setup step.
 *
 * Authentication reuses the mechanism that already authenticates a seller's
 * `blockchainIdentifier` to a buyer: the payload is signed by the offering
 * side's Relation wallet and verified against the wallet already recorded on
 * that Relation. No shared credential is distributed, and a stranger cannot
 * open a Head with us because their offer will not verify against any Relation
 * we hold.
 *
 * Only public material crosses the boundary — verification keys and an
 * advertise address. No signing key ever leaves its Host.
 */

/**
 * Everything the counterparty needs before it can boot, plus the fields that
 * make the offer un-replayable.
 *
 * `ledgerParamsHash` rides along so a mismatch is caught here rather than
 * surfacing much later as `PPViewHashesDontMatch` on the first in-head script
 * spend.
 */
export type HydraHeadOfferPayloadInput = {
	/** Binds the offer to one channel. */
	hydraRelationId: string;
	/** Binds the offer to one Head slot within that channel. */
	headSequence: number;
	/** Single-use, so an old offer cannot be replayed to open an unwanted Head. */
	nonce: string;
	/** Unix ms; an offer that is not started by then is reaped on both sides. */
	expiresAt: string;
	network: string;
	/** Offering side's Hydra verification key (envelope cborHex). */
	hydraVerificationKey: string;
	/** Offering side's node Cardano verification key (envelope cborHex). */
	cardanoVerificationKey: string;
	/**
	 * Publicly reachable `host:port` the counterparty must configure verbatim.
	 * etcd validates a member's advertised URL against the cluster entry, so a
	 * reconstructed value would fail to form the cluster.
	 */
	advertise: string;
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
	ledgerParamsHash: string | null;
};

/**
 * Canonical, order-stable payload. Both sides build this identically and hash
 * it, so any tampered field breaks the signature by construction.
 */
export function buildHydraHeadOfferPayload(input: HydraHeadOfferPayloadInput) {
	return {
		hydraRelationId: input.hydraRelationId,
		headSequence: input.headSequence,
		nonce: input.nonce,
		expiresAt: input.expiresAt,
		network: input.network,
		hydraVerificationKey: input.hydraVerificationKey,
		cardanoVerificationKey: input.cardanoVerificationKey,
		advertise: input.advertise,
		contestationPeriodSeconds: input.contestationPeriodSeconds,
		depositPeriodSeconds: input.depositPeriodSeconds,
		unsyncedPeriodSeconds: input.unsyncedPeriodSeconds,
		ledgerParamsHash: input.ledgerParamsHash,
	};
}

/**
 * Which side proposes.
 *
 * Both operators see themselves as the "local" participant, so nothing in the
 * Relation inherently designates an initiator and both could propose the same
 * Head slot at once. Comparing the two Relation wallet key hashes gives a rule
 * both sides evaluate identically without any coordination: the lower one
 * proposes.
 */
export function isOfferInitiator(localWalletVkey: string, remoteWalletVkey: string): boolean {
	if (localWalletVkey === remoteWalletVkey) {
		// A Relation is between two distinct wallets; identical keys mean it is
		// misconfigured, and guessing an initiator would let both sides propose.
		throw new Error('a hydra relation cannot have the same wallet on both sides');
	}
	return localWalletVkey < remoteWalletVkey;
}

export type OfferFreshness = { fresh: true } | { fresh: false; reason: string };

/**
 * An offer is usable only inside its window. Checked on receipt and again
 * before acting on it, because the two can be far apart when a counterparty is
 * slow to answer.
 */
export function checkOfferFreshness(expiresAtMs: number, nowMs: number): OfferFreshness {
	if (!Number.isSafeInteger(expiresAtMs)) {
		return { fresh: false, reason: 'offer expiry is not a valid timestamp' };
	}
	if (nowMs >= expiresAtMs) {
		return { fresh: false, reason: 'offer has expired' };
	}
	return { fresh: true };
}
