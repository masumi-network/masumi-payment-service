/**
 * Talking to a counterparty's Exchange Plane.
 *
 * The only outbound call in the whole design that reaches an organisation other
 * than our own, and it carries no credential — the invite nonce is the
 * capability, and our material is signed. It is also the only place a URL we
 * did not choose is dialled, so it is guarded accordingly: https or plain http
 * only, no redirects followed, and a bounded timeout.
 *
 * Redirects matter more than they look. An issuer's Exchange Plane URL is
 * signed inside the invite, so following a redirect would let whoever controls
 * that hostname move the redemption somewhere the issuer never vouched for.
 */

import createHttpError from 'http-errors';
import { logger } from '@masumi/payment-core/logger';

const REQUEST_TIMEOUT_MS = 20_000;

export type RedemptionBody = {
	nonce: string;
	redeemer: {
		walletAddress: string;
		hydraVerificationKey: string;
		cardanoVerificationKey: string;
		advertise: string;
		exchangeUrl: string;
	};
	signature: { signature: string; key: string };
};

export type InviteDeliveryBody = {
	nonce: string;
	payload: string;
	signature: { signature: string; key: string };
	issuerWalletAddress: string;
};

function assertDialable(rawUrl: string): URL {
	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw createHttpError(400, 'the counterparty exchange URL is not a URL');
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw createHttpError(400, `the counterparty exchange URL must be http or https, got ${url.protocol}`);
	}
	return url;
}

async function post(rawUrl: string, pathname: string, body: unknown, what: string): Promise<unknown> {
	const url = assertDialable(rawUrl);
	url.pathname = `${url.pathname.replace(/\/+$/, '')}${pathname}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			redirect: 'error',
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		if (!response.ok) {
			// Their status codes are meaningful and worth passing through: 409 is
			// "already redeemed", 410 is "expired", and an operator can act on both.
			const detail = response.status === 409 || response.status === 410 ? await response.text() : '';
			throw createHttpError(
				502,
				`the counterparty refused the ${what} (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ''}`,
			);
		}
		return await response.json().catch(() => null);
	} catch (error) {
		if (createHttpError.isHttpError(error)) {
			throw error;
		}
		const reason = (error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message;
		logger.warn(`hydra: ${what} to ${url.host} failed: ${reason}`);
		throw createHttpError(502, `could not reach the counterparty exchange at ${url.host}: ${reason}`);
	} finally {
		clearTimeout(timer);
	}
}

/** Send our material to the issuer, which is what lets their reserved node boot. */
export async function postRedemption(exchangeUrl: string, body: RedemptionBody): Promise<void> {
	await post(exchangeUrl, '/redeem', body, 'redemption');
}

/**
 * Leave an invite in a counterparty's inbox.
 *
 * Only reachable once they have allow-listed us, which they do when a Relation
 * exists — so this is the second and subsequent Head on a Relation, where no
 * human needs to carry the invite across.
 */
export async function postInvite(exchangeUrl: string, body: InviteDeliveryBody): Promise<void> {
	await post(exchangeUrl, '/invite', body, 'invite');
}
