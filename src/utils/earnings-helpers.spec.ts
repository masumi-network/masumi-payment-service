import { describe, expect, it, jest } from '@jest/globals';
import { fetchAndProcessInBatches } from './earnings-helpers';

describe('fetchAndProcessInBatches', () => {
	it('pages through full batches and stops at a short final page', async () => {
		const pages = [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }, { id: 'd' }], [{ id: 'e' }]];
		const fetchBatch = jest.fn(async () => pages.shift() ?? []);
		const processed: Array<{ id: string }[]> = [];

		await fetchAndProcessInBatches(fetchBatch, 2, (batch) => {
			processed.push(batch);
		});

		expect(processed).toEqual([[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }, { id: 'd' }], [{ id: 'e' }]]);
		expect(fetchBatch).toHaveBeenCalledTimes(3);
	});

	it('passes the last row id of the previous page as the next cursor', async () => {
		const pages = [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]];
		const fetchBatch = jest.fn(async (_cursorId?: string) => pages.shift() ?? []);

		await fetchAndProcessInBatches(fetchBatch, 2, () => {});

		expect(fetchBatch).toHaveBeenNthCalledWith(1, undefined);
		expect(fetchBatch).toHaveBeenNthCalledWith(2, 'b');
	});

	it('stops immediately and never calls processBatch when the first page is empty', async () => {
		const fetchBatch = jest.fn(async () => []);
		const processBatch = jest.fn();

		await fetchAndProcessInBatches(fetchBatch, 2, processBatch);

		expect(fetchBatch).toHaveBeenCalledTimes(1);
		expect(processBatch).not.toHaveBeenCalled();
	});

	it('does not fetch again once a full-size page turns out to be the last one', async () => {
		// A page exactly equal to batchSize looks like there might be more, so the
		// loop must fetch once more to confirm — but an empty follow-up page must
		// stop it there rather than looping forever.
		const pages = [[{ id: 'a' }, { id: 'b' }], []];
		const fetchBatch = jest.fn(async () => pages.shift() ?? []);
		const processBatch = jest.fn();

		await fetchAndProcessInBatches(fetchBatch, 2, processBatch);

		expect(fetchBatch).toHaveBeenCalledTimes(2);
		expect(processBatch).toHaveBeenCalledTimes(1);
	});
	it('does not fetch when the request was already cancelled', async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchBatch = jest.fn(async () => [{ id: 'a' }]);
		await expect(fetchAndProcessInBatches(fetchBatch, 1, () => {}, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		expect(fetchBatch).not.toHaveBeenCalled();
	});

	it('stops before the next query when processing cancels the request', async () => {
		const controller = new AbortController();
		const fetchBatch = jest.fn(async () => [{ id: 'a' }]);
		await expect(
			fetchAndProcessInBatches(
				fetchBatch,
				1,
				() => {
					controller.abort();
				},
				controller.signal,
			),
		).rejects.toMatchObject({ name: 'AbortError' });
		expect(fetchBatch).toHaveBeenCalledTimes(1);
	});
});
