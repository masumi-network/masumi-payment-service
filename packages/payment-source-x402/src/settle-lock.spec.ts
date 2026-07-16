import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockWalletUpdateMany = jest.fn<(input?: unknown) => Promise<{ count: number }>>();
const mockQueryRaw = jest.fn() as jest.Mock<any>;
const mockLoggerError = jest.fn();

jest.unstable_mockModule('@masumi/payment-core/db', () => ({
	Prisma: {},
	prisma: {
		x402EvmWallet: { updateMany: mockWalletUpdateMany },
		$queryRaw: mockQueryRaw,
		$transaction: jest.fn(),
	},
}));

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { error: mockLoggerError },
}));

const { SETTLE_LOCK_HEARTBEAT_MS, withFacilitatorSettleLock } = await import('./settle-lock');

describe('facilitator settle lock heartbeat', () => {
	beforeEach(() => {
		jest.useFakeTimers({ now: new Date('2026-07-16T12:00:00.000Z') });
		jest.clearAllMocks();
		mockWalletUpdateMany.mockResolvedValue({ count: 1 });
		mockQueryRaw.mockImplementation(async (queryParts: readonly string[]) => {
			const sql = queryParts.join('');
			if (sql.includes('UPDATE "X402EvmWallet"')) return [{ lockedAt: new Date(Date.now()) }];
			if (sql.includes('SELECT clock_timestamp()')) return [{ now: new Date(Date.now()) }];
			return [];
		});
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it('renews ownership and the active attempt while a settle is running', async () => {
		let finishSettle: (() => void) | undefined;
		const onHeartbeat = jest.fn(async () => undefined);
		const settle = withFacilitatorSettleLock(
			'wallet-facilitator',
			() =>
				new Promise<void>((resolve) => {
					finishSettle = resolve;
				}),
			{ onHeartbeat },
		);

		await jest.advanceTimersByTimeAsync(0);
		expect(mockQueryRaw).toHaveBeenCalledTimes(1);

		await jest.advanceTimersByTimeAsync(SETTLE_LOCK_HEARTBEAT_MS);
		expect(mockQueryRaw).toHaveBeenCalledTimes(2);
		expect(onHeartbeat).toHaveBeenCalledTimes(1);

		finishSettle?.();
		await settle;
		expect(mockQueryRaw).toHaveBeenCalledTimes(3);
		expect(onHeartbeat).toHaveBeenCalledTimes(2);
		// Acquire + heartbeat + final ownership fence are atomic raw UPDATEs; release remains a
		// compare-and-clear through Prisma.
		for (const [queryParts] of mockQueryRaw.mock.calls as Array<[readonly string[]]>) {
			expect(queryParts.join('')).toContain('UPDATE "X402EvmWallet"');
			expect(queryParts.join('')).toContain('SET "lockedAt" = clock_timestamp()');
			expect(queryParts.join('')).toContain('RETURNING "lockedAt"');
		}
		expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockWalletUpdateMany.mock.calls[0]?.[0]).toMatchObject({
			where: { id: 'wallet-facilitator', lockedAt: expect.any(Date) },
			data: { lockedAt: null },
		});
	});

	it('rejects when a failed heartbeat is followed by lease theft', async () => {
		mockQueryRaw
			.mockResolvedValueOnce([{ lockedAt: new Date(Date.now()) }]) // acquire
			.mockRejectedValueOnce(new Error('heartbeat database unavailable'))
			.mockResolvedValueOnce([]); // final ownership fence detects the stealer
		let finishSettle: (() => void) | undefined;
		const settle = withFacilitatorSettleLock(
			'wallet-facilitator',
			() =>
				new Promise<void>((resolve) => {
					finishSettle = resolve;
				}),
		);

		await jest.advanceTimersByTimeAsync(0);
		await jest.advanceTimersByTimeAsync(SETTLE_LOCK_HEARTBEAT_MS);
		finishSettle?.();

		await expect(settle).rejects.toMatchObject({ status: 409 });
		expect(mockQueryRaw).toHaveBeenCalledTimes(3);
		expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1); // compare-and-release is a no-op in production
		expect(mockLoggerError).toHaveBeenCalledWith(
			'x402 failed to renew facilitator settle lock',
			expect.objectContaining({ facilitatorWalletId: 'wallet-facilitator' }),
		);
	});

	it('rejects when final ownership cannot be checked', async () => {
		mockQueryRaw
			.mockResolvedValueOnce([{ lockedAt: new Date(Date.now()) }]) // acquire
			.mockRejectedValueOnce(new Error('final database unavailable'));

		await expect(withFacilitatorSettleLock('wallet-facilitator', async () => 'settled')).rejects.toMatchObject({
			status: 409,
		});
		expect(mockLoggerError).toHaveBeenCalledWith(
			'x402 failed to confirm facilitator settle lock ownership',
			expect.objectContaining({ facilitatorWalletId: 'wallet-facilitator' }),
		);
		// Preserve any still-owned lease until it becomes stale, fencing reconciliation.
		expect(mockQueryRaw).toHaveBeenCalledTimes(2);
		expect(mockWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('keeps the renewed lease when the mandatory final attempt heartbeat fails', async () => {
		mockQueryRaw.mockResolvedValue([{ lockedAt: new Date(Date.now()) }]);
		const onHeartbeat = jest.fn(async () => {
			throw new Error('attempt update unavailable');
		});
		let finishSettle: (() => void) | undefined;
		const settle = withFacilitatorSettleLock(
			'wallet-facilitator',
			() =>
				new Promise<void>((resolve) => {
					finishSettle = resolve;
				}),
			{ onHeartbeat },
		);
		await jest.advanceTimersByTimeAsync(0);
		await jest.advanceTimersByTimeAsync(SETTLE_LOCK_HEARTBEAT_MS);
		finishSettle?.();

		await expect(settle).rejects.toMatchObject({ status: 409 });
		expect(mockLoggerError).toHaveBeenCalledWith(
			'x402 failed to fence the completed settle attempt',
			expect.objectContaining({ facilitatorWalletId: 'wallet-facilitator' }),
		);
		// Acquire + periodic renew + final renew only: no release after the fencing failure.
		expect(mockQueryRaw).toHaveBeenCalledTimes(3);
		expect(mockWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('does not take a local nonce lock for a remote facilitator', async () => {
		await expect(withFacilitatorSettleLock(null, async () => 'settled')).resolves.toBe('settled');
		expect(mockWalletUpdateMany).not.toHaveBeenCalled();
		expect(mockQueryRaw).not.toHaveBeenCalled();
	});

	it('renews and retains the lease when fn throws after a durable marker exists', async () => {
		const error = new Error('receipt transport failed after broadcast');

		await expect(
			withFacilitatorSettleLock(
				'wallet-facilitator',
				async () => {
					throw error;
				},
				{ retainLeaseOnError: () => true },
			),
		).rejects.toBe(error);

		// Acquire + retention renew only. No compare-and-release: the renewed token expires stale.
		expect(mockQueryRaw).toHaveBeenCalledTimes(2);
		expect(mockWalletUpdateMany).not.toHaveBeenCalled();
	});

	it('releases the lease when fn throws before a durable marker exists', async () => {
		await expect(
			withFacilitatorSettleLock(
				'wallet-facilitator',
				async () => {
					throw new Error('configuration changed before marker');
				},
				{ retainLeaseOnError: () => false },
			),
		).rejects.toThrow('configuration changed before marker');

		expect(mockQueryRaw).toHaveBeenCalledTimes(1);
		expect(mockWalletUpdateMany).toHaveBeenCalledTimes(1);
		expect(mockWalletUpdateMany.mock.calls[0]?.[0]).toMatchObject({
			where: { id: 'wallet-facilitator', lockedAt: expect.any(Date) },
			data: { lockedAt: null },
		});
	});

	it('computes acquisition age and tokens atomically from the database clock', async () => {
		const databaseNow = new Date('2026-07-16T10:00:00.000Z');
		mockQueryRaw.mockResolvedValue([{ lockedAt: databaseNow }]);

		await withFacilitatorSettleLock('wallet-facilitator', async () => 'settled');

		expect(mockQueryRaw).toHaveBeenCalledTimes(2); // acquire + final ownership renew
		const [acquireQuery, walletId, staleSeconds] = mockQueryRaw.mock.calls[0] as [readonly string[], string, number];
		const acquireSql = acquireQuery.join('');
		expect(acquireSql).toContain('UPDATE "X402EvmWallet"');
		expect(acquireSql).toContain('SET "lockedAt" = clock_timestamp()');
		expect(acquireSql).toContain('"lockedAt" < clock_timestamp() - make_interval');
		expect(acquireSql).toContain('RETURNING "lockedAt"');
		expect(walletId).toBe('wallet-facilitator');
		expect(staleSeconds).toBe(300);
		const [renewQuery, renewedWalletId, priorToken] = mockQueryRaw.mock.calls[1] as [readonly string[], string, Date];
		expect(renewQuery.join('')).toContain('AND "lockedAt" =');
		expect(renewedWalletId).toBe('wallet-facilitator');
		expect(priorToken).toEqual(databaseNow);
		expect(mockWalletUpdateMany).toHaveBeenCalledWith({
			where: { id: 'wallet-facilitator', lockedAt: databaseNow },
			data: { lockedAt: null },
		});
	});
});
