/** The supervisor's async primitives: a timer that never holds the process open, and a bounded fan-out. */

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});

export async function mapWithConcurrency<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
	let cursor = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		for (;;) {
			const index = cursor++;
			if (index >= items.length) {
				return;
			}
			await run(items[index]);
		}
	});
	await Promise.all(workers);
}
