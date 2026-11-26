import { describe, expect, it, jest } from '@jest/globals';

const loggerError = jest.fn();
jest.unstable_mockModule('@masumi/payment-core/db', () => ({ prisma: {} }));
jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: { info: jest.fn(), error: loggerError, warn: jest.fn(), debug: jest.fn() },
}));

const { deleteRowsPastRetention, retentionCutoff } = await import('./index');

describe('data retention', () => {
	it('computes the cutoff in whole days before now', () => {
		const now = Date.parse('2026-11-26T12:00:00.000Z');
		expect(retentionCutoff(30, now)?.toISOString()).toBe('2026-10-27T12:00:00.000Z');
	});

	it('never deletes when retention keeps all history', async () => {
		const deleteOlderThan = jest.fn(async () => ({ count: 1 }));
		await deleteRowsPastRetention('T', null, deleteOlderThan);
		expect(deleteOlderThan).not.toHaveBeenCalled();
	});

	it('logs a failed delete instead of failing the scheduler tick', async () => {
		await expect(
			deleteRowsPastRetention('T', 30, async () => {
				throw new Error('boom');
			}),
		).resolves.toBeUndefined();
		expect(loggerError).toHaveBeenCalledWith('Failed to delete rows past retention', { table: 'T', error: 'boom' });
	});
});
