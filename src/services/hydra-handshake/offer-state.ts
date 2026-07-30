/**
 * What to do next with a head offer.
 *
 * Kept pure and separate from the endpoints so each transition can be asserted
 * directly. The ordering matters: an expired offer is reaped before anything
 * else acts on it, because both sides allocated a node and a peer port when the
 * offer was made and those must not be held open indefinitely.
 */

export type OfferStatus = 'Proposed' | 'Accepted' | 'Configured' | 'Started' | 'Completed' | 'Declined' | 'Expired';

export type OfferRole = 'Offerer' | 'Acceptor';

export type OfferView = {
	status: OfferStatus;
	role: OfferRole;
	expiresAtMs: number;
	/** True once the counterparty's verification keys and advertise address are known. */
	hasCounterpartyMaterial: boolean;
	/** True once our node has been told its peers. */
	peersConfigured: boolean;
};

export type OfferAction =
	/** Nothing to do; waiting on the counterparty or already finished. */
	| { kind: 'Idle'; reason: string }
	/** Send the offer to the counterparty. */
	| { kind: 'SendOffer' }
	/** Push the agreed peer set onto our provisioned node. */
	| { kind: 'ConfigurePeers' }
	/** Start our node; the cluster forms once the counterparty starts theirs. */
	| { kind: 'StartNode' }
	/** Record the head this offer agreed, binding both participants to it. */
	| { kind: 'CreateHead' }
	/** Release the node and peer port this offer reserved. */
	| { kind: 'Reap'; reason: string };

/**
 * Decide the next step for one offer.
 *
 * A node is deliberately not started until peers are configured: the peer set
 * becomes etcd's `--initial-cluster`, which is fixed at boot, so starting early
 * would bootstrap a cluster the counterparty cannot join.
 */
export function nextOfferAction(offer: OfferView, nowMs: number): OfferAction {
	if (offer.status === 'Completed') {
		return { kind: 'Idle', reason: 'the head exists; the offer is finished' };
	}

	if (offer.status === 'Started') {
		// Everything the head record needs is already agreed and signed: our own
		// participant, the counterparty's keys and advertise address, and the
		// periods. Neither side waits for the other here — each records its own
		// head, and the two only have to agree on chain, at Init.
		return { kind: 'CreateHead' };
	}

	if (offer.status === 'Declined') {
		// Release immediately rather than waiting for expiry: the counterparty has
		// already said no, so holding the slot serves nothing.
		return { kind: 'Reap', reason: 'the counterparty declined' };
	}

	if (offer.status === 'Expired') {
		return { kind: 'Reap', reason: 'the offer expired' };
	}

	if (nowMs >= offer.expiresAtMs) {
		return { kind: 'Reap', reason: 'the offer expired before both sides were ready' };
	}

	if (offer.status === 'Proposed') {
		// The acceptor has answered the moment it holds our material; the offerer
		// still has to put its proposal on the wire.
		if (offer.role === 'Offerer') {
			return { kind: 'SendOffer' };
		}
		return { kind: 'Idle', reason: 'waiting for the counterparty to accept' };
	}

	// status === 'Accepted' or 'Configured'
	if (!offer.hasCounterpartyMaterial) {
		return { kind: 'Idle', reason: 'waiting for the counterparty verification keys and advertise address' };
	}
	if (!offer.peersConfigured) {
		return { kind: 'ConfigurePeers' };
	}
	return { kind: 'StartNode' };
}

/** Statuses from which an offer may still progress. */
// `Started` counts as open: the node is running and the port is held, but the
// head record does not exist yet. A second offer accepted in that window would
// provision a duplicate node for a slot that is already spoken for.
const OPEN_STATUSES: ReadonlySet<OfferStatus> = new Set(['Proposed', 'Accepted', 'Configured', 'Started']);

export function isOfferOpen(status: OfferStatus): boolean {
	return OPEN_STATUSES.has(status);
}

/**
 * Whether a fresh offer may be made for a Head slot.
 *
 * One open offer per slot: two concurrent offers would each provision a node
 * and reserve a peer port, and only one of them could ever become the Head.
 */
export function canProposeNewOffer(existing: { status: OfferStatus } | null): boolean {
	return existing === null || !isOfferOpen(existing.status);
}
