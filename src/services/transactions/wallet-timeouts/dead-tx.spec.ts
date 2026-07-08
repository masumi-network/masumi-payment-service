import { classifyUnseenPendingTx } from './dead-tx';

describe('classifyUnseenPendingTx', () => {
	const now = 1_000_000_000_000;
	const timeout = 15 * 60 * 1000; // 15 min

	const base = {
		nowMs: now,
		invalidHereafterSlot: null,
		isRegistryTx: true,
		forceUnlockAfterMs: timeout,
	};

	it('force-unlocks a stale registry tx once it is older than the timeout', () => {
		expect(classifyUnseenPendingTx({ ...base, createdAtMs: now - (timeout + 1) })).toEqual({
			forceUnlock: true,
			ageMs: timeout + 1,
		});
	});

	it('force-unlocks exactly at the timeout boundary', () => {
		expect(classifyUnseenPendingTx({ ...base, createdAtMs: now - timeout })).toEqual({
			forceUnlock: true,
			ageMs: timeout,
		});
	});

	it('NEVER force-unlocks a non-registry (payment/purchase) tx, however old — double-spend guard', () => {
		expect(classifyUnseenPendingTx({ ...base, isRegistryTx: false, createdAtMs: now - 10 * timeout })).toEqual({
			forceUnlock: false,
		});
	});

	it('never force-unlocks a registry-flagged tx that unexpectedly carries a persisted TTL slot', () => {
		expect(classifyUnseenPendingTx({ ...base, invalidHereafterSlot: 12345n, createdAtMs: now - 10 * timeout })).toEqual(
			{ forceUnlock: false },
		);
	});

	it('keeps polling a registry tx younger than the timeout', () => {
		expect(classifyUnseenPendingTx({ ...base, createdAtMs: now - (timeout - 1) })).toEqual({ forceUnlock: false });
	});

	it('does not force-unlock when clock skew makes the tx look like it is from the future', () => {
		expect(classifyUnseenPendingTx({ ...base, createdAtMs: now + 5_000 })).toEqual({ forceUnlock: false });
	});
});
