/**
 * Control-plane side of the exchange: what the owning payment service tells
 * this Host to honour.
 *
 * Separate from the Exchange Plane's own handlers because the trust direction
 * is opposite. Everything here arrives with an admin token from a service that
 * already holds the node keys; everything there arrives from a stranger. Only
 * this side may create an invite.
 */

import { ProvisionError } from './provision.js';
import type { ExchangeStore } from '../registry/exchange-store.js';
import type { NodeRegistryStore } from '../registry/store.js';
import type { InviteRecord } from '../registry/exchange-types.js';

const NONCE_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Hard ceiling on how long a reservation may be held, whatever the caller asks for. */
export const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type RegisterInviteBody = {
	nonce: string;
	hostNodeId: string;
	expiresAt: number;
};

function readRegisterBody(body: unknown): RegisterInviteBody {
	if (typeof body !== 'object' || body === null) {
		throw new ProvisionError('expected an invite registration object', 400);
	}
	const candidate = body as Partial<RegisterInviteBody>;
	if (typeof candidate.nonce !== 'string' || !NONCE_PATTERN.test(candidate.nonce)) {
		throw new ProvisionError('nonce must be 8-64 characters of [A-Za-z0-9_-]', 400);
	}
	if (typeof candidate.hostNodeId !== 'string' || !NODE_ID_PATTERN.test(candidate.hostNodeId)) {
		throw new ProvisionError('hostNodeId is not a node id this host could have issued', 400);
	}
	if (typeof candidate.expiresAt !== 'number' || !Number.isFinite(candidate.expiresAt)) {
		throw new ProvisionError('expiresAt must be epoch milliseconds', 400);
	}

	const now = Date.now();
	if (candidate.expiresAt <= now) {
		throw new ProvisionError('expiresAt is already in the past', 400);
	}
	if (candidate.expiresAt > now + MAX_INVITE_TTL_MS) {
		// An invite holds a node and a peer port for its whole life. Without a
		// ceiling a caller could reserve capacity indefinitely by mistake.
		throw new ProvisionError('expiresAt is further out than this host will hold a reservation', 400);
	}

	return { nonce: candidate.nonce, hostNodeId: candidate.hostNodeId, expiresAt: candidate.expiresAt };
}

export async function registerInvite(
	store: ExchangeStore,
	nodes: NodeRegistryStore,
	body: unknown,
): Promise<{ nonce: string }> {
	const parsed = readRegisterBody(body);
	// The pattern above says the id is well formed, not that it names anything.
	// A nonce is single-use and the Exchange Plane burns it before the node is
	// touched: registering one against a node that does not exist means the
	// counterparty publishes their material, is told the redemption succeeded,
	// and the start then fails with `no such node` on an invite that can never be
	// redeemed again.
	if ((await nodes.read(parsed.hostNodeId)) === null) {
		throw new ProvisionError(`no such node: ${parsed.hostNodeId}`, 404);
	}
	const record: InviteRecord = {
		nonce: parsed.nonce,
		hostNodeId: parsed.hostNodeId,
		expiresAt: parsed.expiresAt,
		issuedAt: Date.now(),
		redeemedAt: null,
		redeemer: null,
		redeemerSignature: null,
		startError: null,
	};
	await store.registerInvite(record);
	return { nonce: record.nonce };
}
