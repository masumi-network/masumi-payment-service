/**
 * Where a counterparty's signed head offers are delivered.
 *
 * The offer endpoint lives on the *payment service*, not on the Hydra Host: it
 * reads the relation, signs with the hot wallet and creates offer rows, none of
 * which the Host can see. The Host's proxy must never be handed to a
 * counterparty — its admin token starts and stops node processes.
 *
 * Only this one path needs to be reachable from outside. A deployment that
 * cannot expose its payment service publicly should route
 * `/api/v1/hydra/handshake/offer` through its reverse proxy and nothing else.
 */

import createHttpError from 'http-errors';

/** Path the offer is POSTed to, relative to the counterparty's service origin. */
export const HANDSHAKE_OFFER_PATH = '/api/v1/hydra/handshake/offer';

/**
 * Reduce whatever an operator pasted to a bare origin.
 *
 * They reach for the URL they can see, which for this service ends in
 * `/api/v1` — and appending our own path to that produces
 * `/api/v1/api/v1/hydra/...`, a 404 that surfaces as "the counterparty refused
 * the offer" and sends the operator looking at the wrong side.
 */
export function normalizeCounterpartyBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim().replace(/\/+$/, '');
	if (trimmed.length === 0) {
		throw createHttpError(400, 'counterparty service URL is empty');
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw createHttpError(400, `counterparty service URL is not a URL: ${trimmed}`);
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw createHttpError(400, `counterparty service URL must be http or https, got ${parsed.protocol}`);
	}

	const path = parsed.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
	return `${parsed.origin}${path}`;
}

/** Full URL to POST a signed offer to. */
export function counterpartyOfferUrl(baseUrl: string): string {
	return `${normalizeCounterpartyBaseUrl(baseUrl)}${HANDSHAKE_OFFER_PATH}`;
}
