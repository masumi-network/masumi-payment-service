import { logger } from '@masumi/payment-core/logger';
import createHttpError, { type HttpError } from 'http-errors';
import { HydraTransportError } from '@/lib/hydra';
import { getErrorMessage } from './index';

/**
 * An exposed 502 for a node that failed before Init was sent. Init never
 * reached the node, so this is not a failed Init and the handler records no
 * head error. The cause goes into the text: a node still starting and a wrong
 * URL or token can fail the same way, and the cause often tells them apart.
 * The warn names the head; the endpoint's server-error log records the 502 too.
 * Some faults also arrive here as a closed session: a frame that ws rejects
 * (an oversized one) and a local disconnect racing Init.
 */
export function nodeFailedBeforeInit(hydraHeadId: string, message: string, error: unknown): HttpError {
	const cause = describeTransportFailure(error);
	logger.warn(`[HydraAPI] ${message} before Init`, { hydraHeadId, error: cause });
	return createHttpError(
		502,
		`${message}: ${cause}. Retry once the node is up, or check its URLs and token if this persists`,
		{ cause: error, expose: true },
	);
}

/** Fetch puts the socket error two levels under the transport error, the deepest any path goes. */
const MAX_TRANSPORT_CAUSE_DEPTH = 2;

/**
 * A transport error's message plus the deepest reason it wraps: the close code
 * of a session closed before Greetings, or the ECONNREFUSED under "fetch
 * failed". That reason can carry only a code. An abort repeats the timeout
 * message, so it is skipped.
 */
function describeTransportFailure(error: unknown): string {
	const message = getErrorMessage(error);
	if (!(error instanceof HydraTransportError)) return message;
	let reason: string | undefined;
	let cause = error.cause;
	for (let depth = 0; depth < MAX_TRANSPORT_CAUSE_DEPTH && cause instanceof Error; depth += 1) {
		const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
		if (cause.name !== 'AbortError') reason = cause.message || code || reason;
		cause = 'cause' in cause ? cause.cause : undefined;
	}
	return reason ? `${message}: ${reason}` : message;
}
