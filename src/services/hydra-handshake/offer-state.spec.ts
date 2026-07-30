import { describe, expect, it } from '@jest/globals';
import { canProposeNewOffer, isOfferOpen, nextOfferAction, type OfferView } from './offer-state';

const NOW = 1_000_000;

function offer(overrides: Partial<OfferView> = {}): OfferView {
	return {
		status: 'Accepted',
		role: 'Offerer',
		expiresAtMs: NOW + 60_000,
		hasCounterpartyMaterial: true,
		peersConfigured: false,
		...overrides,
	};
}

describe('nextOfferAction', () => {
	it('sends a freshly proposed offer from the offering side', () => {
		expect(nextOfferAction(offer({ status: 'Proposed' }), NOW)).toEqual({ kind: 'SendOffer' });
	});

	it('leaves the accepting side waiting on a proposed offer', () => {
		expect(nextOfferAction(offer({ status: 'Proposed', role: 'Acceptor' }), NOW).kind).toBe('Idle');
	});

	it('configures peers once the counterparty material is known', () => {
		expect(nextOfferAction(offer(), NOW)).toEqual({ kind: 'ConfigurePeers' });
	});

	// --initial-cluster is fixed at boot, so a node started before its peers are
	// configured would bootstrap a cluster the counterparty cannot join.
	it('never starts a node before its peers are configured', () => {
		const action = nextOfferAction(offer({ peersConfigured: false }), NOW);
		expect(action.kind).not.toBe('StartNode');
	});

	it('starts the node once peers are configured', () => {
		expect(nextOfferAction(offer({ peersConfigured: true }), NOW)).toEqual({ kind: 'StartNode' });
	});

	it('waits when the counterparty material has not arrived', () => {
		expect(nextOfferAction(offer({ hasCounterpartyMaterial: false }), NOW).kind).toBe('Idle');
	});

	// Both sides reserved a node and a peer port when the offer was made; those
	// must not be held open by an offer that can no longer complete.
	it('reaps an offer that passed its expiry', () => {
		const action = nextOfferAction(offer({ expiresAtMs: NOW }), NOW);
		expect(action).toMatchObject({ kind: 'Reap' });
	});

	it('reaps a declined offer immediately rather than waiting for expiry', () => {
		expect(nextOfferAction(offer({ status: 'Declined' }), NOW)).toMatchObject({
			kind: 'Reap',
			reason: 'the counterparty declined',
		});
	});

	it('reaps an already-expired offer', () => {
		expect(nextOfferAction(offer({ status: 'Expired' }), NOW).kind).toBe('Reap');
	});

	// Expiry outranks progress: an offer that ran out of time must not be
	// configured or started just because its material happens to be complete.
	it('prefers reaping over acting on an expired but otherwise ready offer', () => {
		const ready = offer({ status: 'Accepted', peersConfigured: false, expiresAtMs: NOW - 1 });
		expect(nextOfferAction(ready, NOW).kind).toBe('Reap');
	});

	// The handshake is the only way to open a head, so it has to finish the job:
	// everything the head record needs is already agreed and signed by the time
	// the node is running.
	it('records the head once the node is started', () => {
		expect(nextOfferAction(offer({ status: 'Started' }), NOW).kind).toBe('CreateHead');
	});

	// A started node must not be torn down merely because the offer window
	// elapsed — its node is running and its head still has to be recorded.
	it('does not reap a started offer that has passed its expiry', () => {
		expect(nextOfferAction(offer({ status: 'Started', expiresAtMs: NOW - 1 }), NOW).kind).toBe('CreateHead');
	});

	it('idles a completed offer', () => {
		expect(nextOfferAction(offer({ status: 'Completed' }), NOW).kind).toBe('Idle');
	});

	// Completion is terminal, so an expired-looking completed offer must not be
	// reaped: reaping releases the node and peer port the head is using.
	it('does not reap a completed offer that has passed its expiry', () => {
		expect(nextOfferAction(offer({ status: 'Completed', expiresAtMs: NOW - 1 }), NOW).kind).toBe('Idle');
	});
});

describe('isOfferOpen / canProposeNewOffer', () => {
	// `Started` is in-flight, not terminal: the node is running and its peer port
	// is held, but the head record does not exist yet. A second offer accepted in
	// that window would provision a duplicate node for a slot already spoken for.
	it('treats in-flight statuses as open', () => {
		for (const status of ['Proposed', 'Accepted', 'Configured', 'Started'] as const) {
			expect(isOfferOpen(status)).toBe(true);
		}
	});

	it('treats terminal statuses as closed', () => {
		for (const status of ['Completed', 'Declined', 'Expired'] as const) {
			expect(isOfferOpen(status)).toBe(false);
		}
	});

	// Two concurrent offers for one slot would each provision a node and reserve
	// a peer port, and only one could ever become the head.
	it('allows a new offer only when no open one exists', () => {
		expect(canProposeNewOffer(null)).toBe(true);
		expect(canProposeNewOffer({ status: 'Declined' })).toBe(true);
		expect(canProposeNewOffer({ status: 'Expired' })).toBe(true);
		// A completed offer has produced its head; the next head is a new slot.
		expect(canProposeNewOffer({ status: 'Completed' })).toBe(true);
		expect(canProposeNewOffer({ status: 'Proposed' })).toBe(false);
		expect(canProposeNewOffer({ status: 'Accepted' })).toBe(false);
		expect(canProposeNewOffer({ status: 'Started' })).toBe(false);
	});
});
