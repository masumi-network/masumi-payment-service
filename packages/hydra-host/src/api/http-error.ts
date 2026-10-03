/**
 * Errors that carry an HTTP status.
 *
 * A single base class means the server can translate any of them without
 * knowing which module raised it, and — more importantly — an error that
 * forgets to extend it falls through to a 500 rather than leaking an internal
 * message with a misleading 4xx.
 */

export type HttpErrorStatus = 400 | 403 | 404 | 409 | 507;

export class HostApiError extends Error {
	constructor(
		message: string,
		readonly status: HttpErrorStatus,
	) {
		super(message);
		this.name = 'HostApiError';
	}
}

export function isHostApiError(value: unknown): value is HostApiError {
	return value instanceof HostApiError;
}
