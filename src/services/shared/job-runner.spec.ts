import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { Mutex } from 'async-mutex';

const mockInfo = jest.fn();

jest.unstable_mockModule('@masumi/payment-core/logger', () => ({
	logger: {
		info: mockInfo,
	},
}));

const { withJobLock } = await import('./job-runner');

describe('withJobLock', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('skips an overlapping cycle with a job-specific message', async () => {
		const mutex = new Mutex();
		const release = await mutex.acquire();
		const operation = jest.fn<() => Promise<void>>(async () => undefined);

		await expect(withJobLock(mutex, 'submit_result_v2', operation)).resolves.toBeUndefined();

		expect(operation).not.toHaveBeenCalled();
		expect(mockInfo).toHaveBeenCalledWith('submit_result_v2 is already running, skipping cycle');
		release();
	});

	it('releases the lock after the operation finishes', async () => {
		const mutex = new Mutex();
		const operation = jest.fn<() => Promise<string>>(async () => 'done');

		await expect(withJobLock(mutex, 'test_job', operation)).resolves.toBe('done');
		expect(mutex.isLocked()).toBe(false);
	});
});
