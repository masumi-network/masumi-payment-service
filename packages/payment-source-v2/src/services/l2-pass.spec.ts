import { beforeEach, describe, expect, it, jest } from '@jest/globals';

type AnyMock = jest.Mock<(...args: any[]) => any>;

const mockFindUnique = jest.fn() as AnyMock;

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	prisma: { hotWallet: { findUnique: mockFindUnique } },
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { drainL2Pass, waitForFreeWallet, L2_PASS_MAX_ROUNDS, L2_PASS_MAX_DURATION_MS } = await import('./l2-pass');

const FREE = { lockedAt: null, pendingTransactionId: null };
const BUSY = { lockedAt: new Date(), pendingTransactionId: 'tx-1' };

beforeEach(() => {
	jest.clearAllMocks();
	mockFindUnique.mockResolvedValue(FREE);
});

describe('drainL2Pass', () => {
	// The bug this exists to prevent: a pass claims one request per wallet, so
	// running it once answered one escrow and left the rest for the next nudge —
	// one a second, in a head that confirms in milliseconds.
	it('runs until a round finds nothing', async () => {
		const rounds = [3, 2, 1, 0];
		const run = jest.fn(async () => rounds.shift() ?? 0) as AnyMock;

		await expect(drainL2Pass('test', run)).resolves.toBe(6);
		expect(run).toHaveBeenCalledTimes(4);
	});

	it('does not run a second time when the first round is empty', async () => {
		const run = jest.fn(async () => 0) as AnyMock;

		await expect(drainL2Pass('test', run)).resolves.toBe(0);
		expect(run).toHaveBeenCalledTimes(1);
	});

	// A round that always reports progress would otherwise spin forever. The
	// bound is a backstop against a miscounting pass, not a queue-depth limit.
	it('stops rather than spinning when every round claims progress', async () => {
		const run = jest.fn(async () => 1) as AnyMock;

		await expect(drainL2Pass('test', run)).resolves.toBe(L2_PASS_MAX_ROUNDS);
		expect(run).toHaveBeenCalledTimes(L2_PASS_MAX_ROUNDS);
	});

	// Each round queries and claims, so a pass that keeps reporting work holds
	// database connections for as long as the loop runs. Left unbounded in time,
	// it exhausted the pool.
	it('yields on time even while rounds still report work', async () => {
		let now = 0;
		const run = jest.fn(async () => {
			now += L2_PASS_MAX_DURATION_MS;
			return 1;
		}) as AnyMock;
		const realNow = Date.now;
		jest.spyOn(Date, 'now').mockImplementation(() => realNow() + now);

		await expect(drainL2Pass('test', run)).resolves.toBe(1);
		expect(run).toHaveBeenCalledTimes(1);

		jest.spyOn(Date, 'now').mockRestore();
	});

	it('lets a failing round surface rather than swallowing it', async () => {
		const run = jest.fn(async () => {
			throw new Error('pass blew up');
		}) as AnyMock;

		await expect(drainL2Pass('test', run)).rejects.toThrow('pass blew up');
	});
});

describe('waitForFreeWallet', () => {
	it('reports a free wallet without waiting', async () => {
		await expect(waitForFreeWallet('wallet-1', true)).resolves.toBe(true);
		expect(mockFindUnique).toHaveBeenCalledTimes(1);
	});

	// A wallet busy for someone else's work belongs to a pass that cannot see the
	// end of it; blocking would stall this cycle behind an unrelated one.
	it('does not wait on a wallet this pass did not use', async () => {
		mockFindUnique.mockResolvedValue(BUSY);

		const startedAt = Date.now();
		await expect(waitForFreeWallet('wallet-1', false)).resolves.toBe(false);

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(mockFindUnique).toHaveBeenCalledTimes(1);
	});

	it('waits for a wallet it used itself, and takes it once it frees', async () => {
		mockFindUnique.mockResolvedValueOnce(BUSY).mockResolvedValueOnce(BUSY).mockResolvedValue(FREE);

		await expect(waitForFreeWallet('wallet-1', true)).resolves.toBe(true);
		expect(mockFindUnique.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it('reports a wallet that no longer exists as unusable', async () => {
		mockFindUnique.mockResolvedValue(null);

		await expect(waitForFreeWallet('wallet-1', true)).resolves.toBe(false);
	});
});
