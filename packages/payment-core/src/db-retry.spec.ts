import { retryOnSerializationConflict, type RetryOptions } from './db-retry';

// Cast the silent logger via `as unknown as RetryOptions['logger']` because
// the real winston logger returns itself from each method (for chaining) and
// re-declaring that full surface here would be noise. The retry helper never
// inspects the return value.
const silentLogger = {
	debug: () => undefined,
	info: () => undefined,
	warn: () => undefined,
} as unknown as NonNullable<RetryOptions['logger']>;

const fastRetryOptions: RetryOptions = {
	maxRetries: 2,
	baseDelayMs: 1,
	maxDelayMs: 1,
	logger: silentLogger,
};

describe('retryOnSerializationConflict', () => {
	it('returns immediately on success without retrying', async () => {
		let calls = 0;
		const result = await retryOnSerializationConflict(async () => {
			calls += 1;
			return 'ok';
		}, fastRetryOptions);
		expect(result).toBe('ok');
		expect(calls).toBe(1);
	});

	it('does NOT retry non-retryable errors', async () => {
		let calls = 0;
		const err = new Error('something else');
		await expect(
			retryOnSerializationConflict(async () => {
				calls += 1;
				throw err;
			}, fastRetryOptions),
		).rejects.toBe(err);
		expect(calls).toBe(1);
	});

	it('retries Prisma P2034 errors', async () => {
		let calls = 0;
		const result = await retryOnSerializationConflict(async () => {
			calls += 1;
			if (calls < 2) {
				const err: Error & { code?: string } = new Error('write conflict');
				err.code = 'P2034';
				throw err;
			}
			return 'ok';
		}, fastRetryOptions);
		expect(result).toBe('ok');
		expect(calls).toBe(2);
	});

	it('retries Prisma P2028 errors', async () => {
		let calls = 0;
		const result = await retryOnSerializationConflict(async () => {
			calls += 1;
			if (calls < 2) {
				const err: Error & { code?: string } = new Error('tx api');
				err.code = 'P2028';
				throw err;
			}
			return 'ok';
		}, fastRetryOptions);
		expect(result).toBe('ok');
		expect(calls).toBe(2);
	});

	it('retries DriverAdapterError with SQLSTATE 25001 (cause.code)', async () => {
		// Mirrors the exact shape from CI logs:
		// { name: 'DriverAdapterError', cause: { code: '25001', originalCode: '25001' } }
		let calls = 0;
		const result = await retryOnSerializationConflict(async () => {
			calls += 1;
			if (calls < 2) {
				const err: Error & { name: string; cause?: { code: string; originalCode: string } } = new Error(
					'SET TRANSACTION ISOLATION LEVEL must be called before any query',
				);
				err.name = 'DriverAdapterError';
				err.cause = { code: '25001', originalCode: '25001' };
				throw err;
			}
			return 'ok';
		}, fastRetryOptions);
		expect(result).toBe('ok');
		expect(calls).toBe(2);
	});

	it('retries DriverAdapterError with SQLSTATE 40001 (cause.code)', async () => {
		let calls = 0;
		const result = await retryOnSerializationConflict(async () => {
			calls += 1;
			if (calls < 2) {
				const err: Error & { name: string; cause?: { code: string } } = new Error('serialization_failure');
				err.name = 'DriverAdapterError';
				err.cause = { code: '40001' };
				throw err;
			}
			return 'ok';
		}, fastRetryOptions);
		expect(result).toBe('ok');
		expect(calls).toBe(2);
	});

	it('retries PrismaClientKnownRequestError with meta.driverAdapterError.cause.code = 40001', async () => {
		// Mirrors how Prisma rewraps the same underlying conflict for higher-level callers.
		let calls = 0;
		const result = await retryOnSerializationConflict(async () => {
			calls += 1;
			if (calls < 2) {
				const err: Error & {
					code?: string;
					meta?: { driverAdapterError: { cause: { code: string; originalCode: string } } };
				} = new Error('TransactionWriteConflict');
				err.code = 'P2034';
				err.meta = {
					driverAdapterError: { cause: { code: '40001', originalCode: '40001' } },
				};
				throw err;
			}
			return 'ok';
		}, fastRetryOptions);
		expect(result).toBe('ok');
		expect(calls).toBe(2);
	});

	it('exhausts retries and rethrows when conflict persists', async () => {
		let calls = 0;
		const err: Error & { name: string; cause?: { code: string } } = new Error('persistent 25001');
		err.name = 'DriverAdapterError';
		err.cause = { code: '25001' };
		await expect(
			retryOnSerializationConflict(async () => {
				calls += 1;
				throw err;
			}, fastRetryOptions),
		).rejects.toBe(err);
		// maxRetries: 2 means attempts 0, 1, 2 — three total tries before rethrow.
		expect(calls).toBe(3);
	});
});
