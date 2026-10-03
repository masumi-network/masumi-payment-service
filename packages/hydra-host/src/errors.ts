/**
 * Errors that callers branch on.
 *
 * The distinction that matters operationally is "the node is not there" versus
 * "the node answered with something we could not use". Draining treats the
 * first as nothing left to protect, but must not treat the second that way — a
 * node returning a malformed body is still live and may have a snapshot round
 * in flight.
 */

/** The node's API could not be reached at all: connection refused, reset, or timed out. */
export class NodeUnreachableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NodeUnreachableError';
	}
}

/** The node answered, but with an error status or a body we could not parse. */
export class NodeResponseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NodeResponseError';
	}
}
