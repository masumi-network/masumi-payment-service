import { describe, expect, it } from '@jest/globals';
import { withCostModelLock } from './build-lock';

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe('process-wide cost-model build lock', () => {
	it('permits nested sync in the same active build', async () => {
		await expect(withCostModelLock(async () => await withCostModelLock(async () => 'nested'))).resolves.toBe('nested');
	});

	it('does not let a detached task reuse ownership after its build returns', async () => {
		const detachedStart = deferred();
		const currentHeld = deferred();
		const currentRelease = deferred();
		let detached!: Promise<void>;
		let entered = false;
		await withCostModelLock(async () => {
			detached = (async () => {
				await detachedStart.promise;
				await withCostModelLock(async () => {
					entered = true;
				});
			})();
		});
		const current = withCostModelLock(async () => {
			currentHeld.resolve();
			await currentRelease.promise;
		});
		await currentHeld.promise;
		detachedStart.resolve();
		try {
			await new Promise((done) => setImmediate(done));
			expect(entered).toBe(false);
		} finally {
			currentRelease.resolve();
			await Promise.all([current, detached]);
		}
		expect(entered).toBe(true);
	});
});
