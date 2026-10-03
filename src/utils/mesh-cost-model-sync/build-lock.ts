import { AsyncLocalStorage } from 'node:async_hooks';
import { Mutex } from 'async-mutex';

const buildMutex = new Mutex();
const ownership = new AsyncLocalStorage<{ active: boolean }>();

/** All SDK model arrays are process-global, including across provider keys. */
export async function withCostModelLock<T>(operation: () => Promise<T>): Promise<T> {
	if (ownership.getStore()?.active === true) return await operation();
	return await buildMutex.runExclusive(async () => {
		const context = { active: true };
		return await ownership.run(context, async () => {
			try {
				return await operation();
			} finally {
				context.active = false;
			}
		});
	});
}
