/**
 * Credentials for reaching a hydra-node through a Hydra Host.
 *
 * A node has no authentication of its own, so when it sits behind a Host the
 * bearer token is the only thing separating our client from an API that can
 * close the head. This module is the single place that turns a token into a
 * header, so the rules below hold everywhere rather than per call site.
 *
 * The token travels as a header and never in the URL: `node-url.ts` rejects
 * URLs carrying userinfo, and a credential in a URL ends up in logs, metrics
 * and error messages.
 */

import { HydraProtocolError } from './errors';

/**
 * Characters that would terminate the header and let a token inject further
 * headers. A token is operator-supplied configuration rather than user input,
 * but it reaches us through the database and an API, so it is validated rather
 * than trusted.
 */
const HEADER_UNSAFE = /[\r\n\0]/;

export function assertUsableHydraAuthToken(authToken: string): void {
	if (authToken.trim().length === 0) {
		throw new HydraProtocolError('Hydra node auth token must not be blank');
	}
	if (HEADER_UNSAFE.test(authToken)) {
		throw new HydraProtocolError('Hydra node auth token must not contain control characters');
	}
}

/**
 * Build the Authorization header for a node request.
 *
 * Returns an empty object when no token is configured, which is the loopback
 * case: a node reached directly on 127.0.0.1 has nothing in front of it to
 * authenticate to.
 */
export function hydraAuthHeaders(authToken?: string): Record<string, string> {
	if (authToken === undefined) {
		return {};
	}
	assertUsableHydraAuthToken(authToken);
	return { Authorization: `Bearer ${authToken}` };
}
