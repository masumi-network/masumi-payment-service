/**
 * A request that can never succeed has to reach an operator.
 *
 * The six in-head passes take the oldest eligible request per wallet, and every
 * failure only stood it down for a flat minute. A request whose failure can
 * never clear — a body the head deterministically refuses, a head latched
 * closing — was therefore re-picked every minute forever, decrypting a mnemonic
 * and signing a body each time, while its escrow ran out its deadline and never
 * reached the manual-action queue anyone reads.
 */

import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

let rotation: typeof import('./l2-queue-rotation');

beforeAll(async () => {
	rotation = await import('./l2-queue-rotation');
});

beforeEach(() => {
	rotation.clearL2Deferrals();
	jest.useFakeTimers();
	jest.setSystemTime(new Date('2026-08-19T00:00:00.000Z'));
});

/** How long the request stays excluded after `standDown` calls so far. */
function standDownFor(requestId: string): number {
	const started = Date.now();
	for (let elapsed = 0; elapsed <= rotation.MAX_L2_DEFERRAL_COOLDOWN_MS + 1_000; elapsed += 1_000) {
		jest.setSystemTime(started + elapsed);
		if (!rotation.deferredL2RequestIds().includes(requestId)) return elapsed;
	}
	jest.setSystemTime(started);
	return Number.POSITIVE_INFINITY;
}

describe('standDownL2Request', () => {
	it('backs a repeatedly failing request off, up to the ceiling', async () => {
		const park = jest.fn(async () => {});
		const seen: number[] = [];

		for (let attempt = 0; attempt < 8; attempt++) {
			const at = Date.now();
			await rotation.standDownL2Request('request-1', park);
			seen.push(standDownFor('request-1'));
			jest.setSystemTime(at + rotation.MAX_L2_DEFERRAL_COOLDOWN_MS + 1_000);
		}

		expect(seen[0]).toBeLessThanOrEqual(rotation.L2_DEFERRAL_COOLDOWN_MS);
		expect(seen[1]).toBeGreaterThan(seen[0]!);
		expect(Math.max(...seen)).toBeLessThanOrEqual(rotation.MAX_L2_DEFERRAL_COOLDOWN_MS);
		expect(park).not.toHaveBeenCalled();
	});

	it('parks the request once it has used up its attempts', async () => {
		const park = jest.fn(async () => {});

		for (let attempt = 0; attempt < rotation.MAX_L2_ATTEMPTS; attempt++) {
			await rotation.standDownL2Request('request-1', park);
		}

		expect(park).toHaveBeenCalledTimes(1);
		// Parked, so nothing is holding a place in the queue for it any more.
		jest.setSystemTime(Date.now() + rotation.MAX_L2_DEFERRAL_COOLDOWN_MS + 1_000);
		expect(rotation.deferredL2RequestIds()).not.toContain('request-1');
	});

	// The caller's next statement is the wallet unlock. Losing that to a database
	// error here would strand the wallet and stop every request on it.
	it('does not throw when the park fails, and tries again next time', async () => {
		const park = jest.fn(async () => {
			throw new Error('database is down');
		});

		for (let attempt = 0; attempt < rotation.MAX_L2_ATTEMPTS; attempt++) {
			await expect(rotation.standDownL2Request('request-1', park)).resolves.toBeUndefined();
		}
		expect(park).toHaveBeenCalledTimes(1);

		await rotation.standDownL2Request('request-1', park);

		expect(park).toHaveBeenCalledTimes(2);
	});

	it('starts the count over once the request progresses', async () => {
		const park = jest.fn(async () => {});

		for (let attempt = 0; attempt < rotation.MAX_L2_ATTEMPTS - 1; attempt++) {
			await rotation.standDownL2Request('request-1', park);
		}
		rotation.clearL2RequestAttempts('request-1');
		await rotation.standDownL2Request('request-1', park);

		expect(park).not.toHaveBeenCalled();
		expect(rotation.deferredL2RequestIds()).toContain('request-1');
	});

	it('counts each request separately', async () => {
		const park = jest.fn(async () => {});

		for (let attempt = 0; attempt < rotation.MAX_L2_ATTEMPTS; attempt++) {
			await rotation.standDownL2Request('request-1', park);
			await rotation.standDownL2Request('request-2', () => Promise.resolve());
		}

		expect(park).toHaveBeenCalledTimes(1);
	});
});
