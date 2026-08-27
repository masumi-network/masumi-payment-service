import { afterEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('./logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { deriveSerializableLimit } = await import('./serializable-semaphore');

const ORIGINAL_URL = process.env.DATABASE_URL;
const ORIGINAL_OVERRIDE = process.env.DB_SERIALIZABLE_CONCURRENCY;

function withPool(limit: string | null): void {
	process.env.DATABASE_URL =
		limit === null
			? 'postgresql://u@localhost:5432/db?schema=public'
			: `postgresql://u@localhost:5432/db?schema=public&connection_limit=${limit}`;
}

afterEach(() => {
	if (ORIGINAL_URL === undefined) delete process.env.DATABASE_URL;
	else process.env.DATABASE_URL = ORIGINAL_URL;
	if (ORIGINAL_OVERRIDE === undefined) delete process.env.DB_SERIALIZABLE_CONCURRENCY;
	else process.env.DB_SERIALIZABLE_CONCURRENCY = ORIGINAL_OVERRIDE;
});

describe('deriveSerializableLimit', () => {
	// A deployment that never set connection_limit must keep the concurrency it
	// already had; this sizing is not worth a silent behaviour change.
	it('is unchanged for the historical default pool', () => {
		withPool(null);
		expect(deriveSerializableLimit()).toBe(4);

		withPool('5');
		expect(deriveSerializableLimit()).toBe(4);
	});

	/**
	 * The failure this prevents.
	 *
	 * A serializable transaction holds its connection for its whole life. At
	 * `connectionLimit - 1` slots, a busy service ties up every connection but
	 * one, and every plain query in the process — including the ones that
	 * establish the Hydra head connection — queues behind that single spare and
	 * times out. Raising connection_limit made it worse, because the cap scaled
	 * with the pool.
	 */
	it('leaves headroom that grows with the pool', () => {
		withPool('25');
		expect(deriveSerializableLimit()).toBe(12);

		withPool('50');
		expect(deriveSerializableLimit()).toBe(25);
	});

	it('never grants more slots than the pool has connections', () => {
		for (const limit of ['1', '2', '3', '4', '5', '10', '25', '100']) {
			withPool(limit);
			expect(deriveSerializableLimit()).toBeLessThanOrEqual(Number(limit));
			expect(deriveSerializableLimit()).toBeGreaterThanOrEqual(1);
		}
	});

	it('never reduces concurrency when the pool is raised', () => {
		let previous = 0;
		for (const limit of [5, 6, 8, 10, 16, 25, 50, 100]) {
			withPool(String(limit));
			const slots = deriveSerializableLimit();
			expect(slots).toBeGreaterThanOrEqual(previous);
			previous = slots;
		}
	});

	it('lets an operator override it outright', () => {
		withPool('25');
		process.env.DB_SERIALIZABLE_CONCURRENCY = '3';

		expect(deriveSerializableLimit()).toBe(3);
	});
});
