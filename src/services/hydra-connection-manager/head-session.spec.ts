import { describe, expect, it, jest } from '@jest/globals';
import type { CustomHydraHead } from '@/lib/hydra';

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { HeadSession } = await import('./head-session');

const fakeHead = () => ({}) as CustomHydraHead;
const attachment = (head: CustomHydraHead, ownerEpoch = 1n) => ({ head, provider: {}, ownerEpoch }) as never;

describe('HeadSession attachment and fences', () => {
	it('allows mutation only for the current, unfenced attachment', () => {
		const session = new HeadSession('head-1');
		const head = fakeHead();
		expect(session.isMutationAllowed(head)).toBe(false);
		session.attach(attachment(head));
		expect(session.isMutationAllowed(head)).toBe(true);
		expect(session.isMutationAllowed(fakeHead())).toBe(false);
	});

	it('quarantine fences every transport, not just the failed one', () => {
		// A quarantine means durable lifecycle state may be stale; until it is
		// re-observed, nothing may act on this head — including a replacement
		// transport attached while the fence stands.
		const session = new HeadSession('head-1');
		const failed = fakeHead();
		const replacement = fakeHead();
		session.attach(attachment(failed));
		session.quarantine(failed);
		expect(session.isMutationAllowed(failed)).toBe(false);
		session.attach(attachment(replacement, 2n));
		expect(session.isMutationAllowed(replacement)).toBe(false);
	});

	it('only a different transport can clear a quarantine by re-observation', () => {
		const session = new HeadSession('head-1');
		const failed = fakeHead();
		session.quarantine(failed);
		session.clearQuarantineAfterReobservation(failed);
		expect(session.isQuarantined).toBe(true);
		session.clearQuarantineAfterReobservation(fakeHead());
		expect(session.isQuarantined).toBe(false);
	});

	it('revocation fences exactly the named transport and dies with it', () => {
		const session = new HeadSession('head-1');
		const old = fakeHead();
		session.attach(attachment(old));
		session.revokeCommands(old);
		expect(session.isMutationAllowed(old)).toBe(false);
		// Teardown of the revoked transport releases the fence with it; a newer
		// attachment must start unfenced.
		session.detachIfCurrent(old);
		const replacement = fakeHead();
		session.attach(attachment(replacement, 2n));
		expect(session.isMutationAllowed(replacement)).toBe(true);
	});

	it('an older detach cannot drop a replacement attachment', () => {
		const session = new HeadSession('head-1');
		const old = fakeHead();
		const replacement = fakeHead();
		session.attach(attachment(old));
		session.attach(attachment(replacement, 2n));
		session.detachIfCurrent(old);
		expect(session.attachment?.head).toBe(replacement);
	});
});

describe('HeadSession queues', () => {
	it('serializes status work and flushes through chained enqueues', async () => {
		const session = new HeadSession('head-1');
		const order: number[] = [];
		let releaseFirst!: () => void;
		session.enqueueStatus(
			() =>
				new Promise<void>((resolve) => {
					releaseFirst = () => {
						order.push(1);
						resolve();
					};
				}),
		);
		session.enqueueStatus(async () => {
			order.push(2);
		});
		// Ops start on the queue's microtask, matching the manager's original
		// behavior; give the first one a beat to begin before releasing it.
		await new Promise((resolve) => setImmediate(resolve));
		const flushed = session.flushStatus();
		releaseFirst();
		await flushed;
		expect(order).toEqual([1, 2]);
	});

	it('a rejected status op does not wedge the queue', async () => {
		const session = new HeadSession('head-1');
		const ran = jest.fn();
		session.enqueueStatus(async () => {
			throw new Error('persist failed');
		});
		session.enqueueStatus(async () => {
			ran();
		});
		await session.flushStatus();
		expect(ran).toHaveBeenCalledTimes(1);
	});

	it('deduplicates confirmed-tx work by transaction id while in flight', async () => {
		const session = new HeadSession('head-1');
		let release!: () => void;
		const op = jest.fn(
			() =>
				new Promise<'applied'>((resolve) => {
					release = () => resolve('applied');
				}),
		);
		const first = session.runTxConfirmed('tx-1', op);
		const second = session.runTxConfirmed('tx-1', op);
		expect(second).toBe(first);
		await new Promise((resolve) => setImmediate(resolve));
		expect(op).toHaveBeenCalledTimes(1);
		release();
		await expect(first).resolves.toBe('applied');
		// Once settled, the same id runs fresh work again (a later replay pass).
		const third = session.runTxConfirmed('tx-1', async () => 'irrelevant' as const);
		await expect(third).resolves.toBe('irrelevant');
	});

	it('control work runs even when its predecessor failed', async () => {
		const session = new HeadSession('head-1');
		const failing = session.runControl(async () => {
			throw new Error('reconcile failed');
		});
		await expect(failing).rejects.toThrow('reconcile failed');
		await expect(session.runControl(async () => true)).resolves.toBe(true);
	});

	it('shares one in-flight connect across callers', async () => {
		const session = new HeadSession('head-1');
		let release!: () => void;
		const op = jest.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const first = session.runConnect(op);
		const second = session.runConnect(op);
		expect(second).toBe(first);
		expect(op).toHaveBeenCalledTimes(1);
		release();
		await first;
	});
});

describe('HeadSession timers', () => {
	it('schedules one reconnect at a time and resets attempts on clear', () => {
		jest.useFakeTimers();
		try {
			const session = new HeadSession('head-1');
			const run = jest.fn();
			session.scheduleReconnect(run);
			session.scheduleReconnect(run);
			jest.advanceTimersByTime(1_000);
			expect(run).toHaveBeenCalledTimes(1);
			// Second attempt backs off beyond the initial delay.
			session.scheduleReconnect(run);
			jest.advanceTimersByTime(1_000);
			expect(run).toHaveBeenCalledTimes(1);
			jest.advanceTimersByTime(1_000);
			expect(run).toHaveBeenCalledTimes(2);
			// A successful reconcile clears the counter: the next retry is fast again.
			session.clearReconnect();
			session.scheduleReconnect(run);
			jest.advanceTimersByTime(1_000);
			expect(run).toHaveBeenCalledTimes(3);
		} finally {
			jest.useRealTimers();
		}
	});

	it('replaces the clock refresher instead of stacking intervals', () => {
		jest.useFakeTimers();
		try {
			const session = new HeadSession('head-1');
			const first = jest.fn();
			const second = jest.fn();
			session.startClockRefresh(1_000, first);
			expect(first).toHaveBeenCalledTimes(1);
			session.startClockRefresh(1_000, second);
			jest.advanceTimersByTime(3_000);
			expect(first).toHaveBeenCalledTimes(1);
			expect(second).toHaveBeenCalledTimes(4);
			session.stopClockRefresh();
			jest.advanceTimersByTime(3_000);
			expect(second).toHaveBeenCalledTimes(4);
		} finally {
			jest.useRealTimers();
		}
	});
});
