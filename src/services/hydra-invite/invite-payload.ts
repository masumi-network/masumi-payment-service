/**
 * The signed object one operator hands another to open a Hydra Head.
 *
 * A Head Invite differs from the wire offer it replaces in one decisive way: it
 * carries the issuer's *complete* public material. The recipient therefore has
 * everything it must trust before it answers, and the answer carries nothing
 * back that needs authenticating — which is why the exchange can terminate on a
 * Host that holds no wallet key. See ADR 0011.
 *
 * Because a node serves exactly one Head, and `--peer`,
 * `--hydra-verification-key` and `--initial-cluster` are all *startup*
 * configuration whose etcd data dir is content-addressed by them, issuing an
 * invite means reserving a node and a peer port. The invite cannot be re-pointed
 * at a different counterparty afterwards.
 *
 * Only public material crosses the boundary. No signing key ever leaves its
 * Host, and no signing key is needed to redeem.
 */

/** Everything the recipient needs, plus the fields that make an invite un-replayable. */
export type HydraHeadInvitePayloadInput = {
	/** Single-use. Redeeming it is what lets the reserved node boot. */
	nonce: string;
	/** Unix ms as a string, so the canonical form does not depend on number formatting. */
	expiresAt: string;
	network: string;
	/** The wallet that identifies the issuer. Authority is bound to this. */
	issuerWalletAddress: string;
	/**
	 * Which side of a trade the issuer's wallet plays.
	 *
	 * A head carries payments in one direction: the buyer's wallet locks funds
	 * and the seller's collects them. Two buyers, or two sellers, produce a head
	 * no payment can ever route through, and nothing about it looks wrong until
	 * a payment quietly settles on L1 instead.
	 *
	 * Signed rather than sent alongside, because the redeemer decides which of
	 * its own wallets to use based on this: an unsigned value would let anyone
	 * who relays the invite steer that choice.
	 */
	issuerWalletRole: 'Buyer' | 'Seller';
	/** Issuer's Hydra verification key (envelope cborHex). */
	hydraVerificationKey: string;
	/** Issuer's node Cardano verification key (envelope cborHex). */
	cardanoVerificationKey: string;
	/**
	 * Publicly reachable `host:port` the redeemer must configure verbatim. etcd
	 * validates a member's advertised URL against the cluster entry, so a
	 * reconstructed value would fail to form the cluster.
	 */
	advertise: string;
	/** Where this invite is redeemed — the issuer's Exchange Plane. */
	exchangeUrl: string;
	contestationPeriodSeconds: number;
	depositPeriodSeconds: number;
	unsyncedPeriodSeconds: number;
	/**
	 * Ledger parameter fingerprint, so a mismatch is caught while it is still
	 * cheap rather than as PPViewHashesDontMatch on the first in-head spend.
	 */
	ledgerParamsHash: string | null;
};

/**
 * Version tag, so a field change is a rejected signature rather than a silent
 * misread.
 *
 * Moving it is a coordinated upgrade, not a rolling one: an invite signed as v1
 * no longer verifies here, and a peer still on v1 cannot verify what we issue.
 * Both sides must deploy before either issues an invite the other will accept.
 * Accepting both versions was considered and rejected — the version exists to
 * make a payload shape unambiguous, and honouring the old one would keep the
 * ambiguity it was added to remove.
 */
export const HYDRA_INVITE_PAYLOAD_VERSION = 'masumi.hydra.invite.v2';

/**
 * Canonical, order-stable payload.
 *
 * Both sides build this identically and hash it, so any tampered field breaks
 * the signature by construction. Keys are listed explicitly rather than spread
 * from the input: a field added to the type must be added here deliberately,
 * which is what stops an unsigned field slipping into the exchange.
 */
export function buildHydraHeadInvitePayload(input: HydraHeadInvitePayloadInput) {
	return {
		version: HYDRA_INVITE_PAYLOAD_VERSION,
		nonce: input.nonce,
		expiresAt: input.expiresAt,
		network: input.network,
		issuerWalletAddress: input.issuerWalletAddress,
		issuerWalletRole: input.issuerWalletRole,
		hydraVerificationKey: input.hydraVerificationKey,
		cardanoVerificationKey: input.cardanoVerificationKey,
		advertise: input.advertise,
		exchangeUrl: input.exchangeUrl,
		contestationPeriodSeconds: input.contestationPeriodSeconds,
		depositPeriodSeconds: input.depositPeriodSeconds,
		unsyncedPeriodSeconds: input.unsyncedPeriodSeconds,
		ledgerParamsHash: input.ledgerParamsHash,
	};
}

/**
 * What the redeemer sends back.
 *
 * Signed too, but for a different reason: the issuer cannot refuse it — the
 * node is already starting — so this signature is what lets the issuer's
 * operator find out afterwards *who* redeemed, and lets the service verify that
 * the material its Host accepted really came from that wallet.
 */
export type HydraRedemptionPayloadInput = {
	/** Ties the redemption to exactly one invite. */
	nonce: string;
	network: string;
	redeemerWalletAddress: string;
	hydraVerificationKey: string;
	cardanoVerificationKey: string;
	advertise: string;
	/** Where the redeemer receives invites, so the next Head needs no paste. */
	exchangeUrl: string;
};

export const HYDRA_REDEMPTION_PAYLOAD_VERSION = 'masumi.hydra.redemption.v1';

export function buildHydraRedemptionPayload(input: HydraRedemptionPayloadInput) {
	return {
		version: HYDRA_REDEMPTION_PAYLOAD_VERSION,
		nonce: input.nonce,
		network: input.network,
		redeemerWalletAddress: input.redeemerWalletAddress,
		hydraVerificationKey: input.hydraVerificationKey,
		cardanoVerificationKey: input.cardanoVerificationKey,
		advertise: input.advertise,
		exchangeUrl: input.exchangeUrl,
	};
}

/** How long an invite may sit before its reservation is released. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function checkInviteFreshness(expiresAtMs: number, nowMs: number): { fresh: boolean; reason: string } {
	if (!Number.isFinite(expiresAtMs)) {
		return { fresh: false, reason: 'invite has no usable expiry' };
	}
	if (expiresAtMs <= nowMs) {
		return { fresh: false, reason: 'invite has expired' };
	}
	// An invite claiming to live far longer than this service would ever issue
	// is either from a misconfigured peer or forged against a stale schema.
	if (expiresAtMs > nowMs + INVITE_TTL_MS * 2) {
		return { fresh: false, reason: 'invite expiry is implausibly far away' };
	}
	return { fresh: true, reason: '' };
}
