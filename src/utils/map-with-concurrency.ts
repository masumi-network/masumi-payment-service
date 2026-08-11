/**
 * Run an async operation over a list, at most `limit` in flight at once.
 *
 * A bounded `Promise.allSettled`: like it, one item's failure never stops the
 * others, and unlike it, the whole list is not started at once. Reach for this
 * wherever the per-item work is an outbound call — a burst of N concurrent
 * requests trips rate limits and buries the useful work, and a plain `for` loop
 * throws the concurrency away.
 *
 * Failures are isolated per item and reported through `onError` rather than
 * thrown, so the pool drains to the end regardless of how any one item fared.
 * The default swallows, matching the `allSettled` this replaces; pass a handler
 * to log.
 */
export async function mapWithConcurrency<T>(
	items: readonly T[],
	limit: number,
	run: (item: T, index: number) => Promise<void>,
	onError: (error: unknown, item: T, index: number) => void = () => {},
): Promise<void> {
	const workerCount = Math.max(1, Math.min(Math.floor(limit), items.length));
	if (items.length === 0) return;

	let cursor = 0;
	const workers = Array.from({ length: workerCount }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) return;
			try {
				await run(items[index], index);
			} catch (error) {
				onError(error, items[index], index);
			}
		}
	});
	await Promise.all(workers);
}
