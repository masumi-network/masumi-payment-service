import createHttpError from 'http-errors';

/**
 * Decide the stored `usageLimited` flag for a new API key.
 *
 * The create schema leaves the field optional with no default on purpose, so an
 * omitted value stays distinguishable from an explicit one. While the schema
 * defaulted it to `true`, the admin guard here fired on the plain documented admin
 * create call (`POST /api-key {permission: 'Admin'}`) and rejected it with
 * `400 'Admin API keys cannot have usage limits'` for a flag the caller never sent,
 * so no admin key could be created through the API at all.
 */
export function resolveCreateUsageLimited({
	isAdmin,
	requested,
}: {
	isAdmin: boolean;
	requested: boolean | undefined;
}): boolean {
	// Reject only an EXPLICIT enable, which is how the update path already behaves.
	if (isAdmin && requested === true) {
		throw createHttpError(400, 'Admin API keys cannot have usage limits');
	}
	// Admin keys are never usage limited. Every other key stays limited unless the
	// caller explicitly opts out.
	return isAdmin ? false : (requested ?? true);
}
