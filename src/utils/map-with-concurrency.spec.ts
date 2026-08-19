import { describe, expect, it, jest } from '@jest/globals';

import { mapWithConcurrency } from './map-with-concurrency';

/** A gate that resolves when released, to hold work in flight deterministically. */
function deferred(): { promise: Promise<void>; release: () => void } {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

describe('mapWithConcurrency', () => {
	it('runs every item', async () => {
		const seen: number[] = [];
		await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (item) => {
			seen.push(item);
		});
		expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
	});

	it('never exceeds the concurrency limit', async () => {
		let inFlight = 0;
		let peak = 0;
		const gates = Array.from({ length: 6 }, deferred);

		const done = mapWithConcurrency(gates, 2, async (gate) => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await gate.promise;
			inFlight -= 1;
		});

		// Let the two workers pick up their first items, then release in waves.
		await Promise.resolve();
		expect(inFlight).toBe(2);
		gates.forEach((gate) => gate.release());
		await done;

		expect(peak).toBe(2);
	});

	it('isolates a failure so the rest still run', async () => {
		const seen: number[] = [];
		await mapWithConcurrency([1, 2, 3], 3, async (item) => {
			if (item === 2) throw new Error('item two failed');
			seen.push(item);
		});
		expect(seen.sort((a, b) => a - b)).toEqual([1, 3]);
	});

	it('reports each failure through onError rather than throwing', async () => {
		const onError = jest.fn();
		await expect(
			mapWithConcurrency(
				[1, 2],
				2,
				async (item) => {
					throw new Error(`boom ${item}`);
				},
				onError,
			),
		).resolves.toBeUndefined();
		expect(onError).toHaveBeenCalledTimes(2);
	});

	it('does nothing for an empty list', async () => {
		const run = jest.fn(async () => {});
		await mapWithConcurrency([], 4, run);
		expect(run).not.toHaveBeenCalled();
	});

	it('caps workers at the item count when the limit is larger', async () => {
		let peak = 0;
		let inFlight = 0;
		await mapWithConcurrency([1, 2], 10, async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await Promise.resolve();
			inFlight -= 1;
		});
		expect(peak).toBeLessThanOrEqual(2);
	});

	it('treats a limit below one as a single worker rather than stalling', async () => {
		const seen: number[] = [];
		await mapWithConcurrency([1, 2, 3], 0, async (item) => {
			seen.push(item);
		});
		expect(seen).toEqual([1, 2, 3]);
	});
});
