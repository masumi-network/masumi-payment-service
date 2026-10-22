import { describe, expect, it } from '@jest/globals';
import { isNotFound } from './service';

/**
 * A newly provisioned node's address has never been used, so every balance read
 * on it 404s. Reading that as "the chain is unreachable" rather than "zero" is
 * the worst possible inversion: the node that most needs funding is the one
 * that gets skipped, the UI reports it as already funded, and Init later fails
 * with NoSeedInput. It happened, because the check matched on prose.
 */
describe('isNotFound', () => {
	it('recognises the status code Blockfrost sets on the error', () => {
		expect(isNotFound(Object.assign(new Error('whatever'), { status_code: 404 }))).toBe(true);
	});

	// The exact wording that defeated a /not found/i match: the string is
	// "has not been found", which does not contain "not found".
	it('is not fooled by Blockfrost wording alone', () => {
		const worded = new Error('The requested component has not been found.');
		expect(isNotFound(worded)).toBe(false);
		expect(isNotFound(Object.assign(worded, { status_code: 404 }))).toBe(true);
	});

	it('accepts a bare 404 in the message as a fallback', () => {
		expect(isNotFound(new Error('Request failed with status 404'))).toBe(true);
	});

	it.each([429, 500])('keeps structured status %s authoritative when the message mentions 404', (status) => {
		const error = Object.assign(new Error('Upstream request failed while handling a 404 response'), {
			status_code: status,
		});
		expect(isNotFound(error)).toBe(false);
	});

	it.each(['404', null, undefined])('does not infer an empty address from an invalid supplied status %p', (status) => {
		expect(isNotFound({ status_code: status, message: 'Request failed with status 404' })).toBe(false);
	});

	it.each([
		['a rate limit', Object.assign(new Error('too many requests'), { status_code: 429 })],
		['a server fault', Object.assign(new Error('bad gateway'), { status_code: 502 })],
		['a transport failure', new Error('fetch failed')],
	])('treats %s as unknown rather than zero', (_label, error) => {
		expect(isNotFound(error)).toBe(false);
	});

	it('tolerates a non-error value', () => {
		expect(isNotFound(undefined)).toBe(false);
		expect(isNotFound('nope')).toBe(false);
	});
});
