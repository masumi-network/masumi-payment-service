import { isPrismaWriteConflict, retryPrismaWriteConflict } from './write-conflict-retry';

describe('write conflict retry', () => {
	it('recognizes Prisma and nested PostgreSQL concurrency errors', () => {
		expect(isPrismaWriteConflict({ code: 'P2034' })).toBe(true);
		expect(isPrismaWriteConflict({ code: 'P2028' })).toBe(true);
		expect(isPrismaWriteConflict({ cause: { code: '40001' } })).toBe(true);
		expect(isPrismaWriteConflict({ cause: { code: '40P01' } })).toBe(true);
		expect(isPrismaWriteConflict({ cause: { originalCode: '25001' } })).toBe(true);
		expect(
			isPrismaWriteConflict({
				meta: {
					driverAdapterError: {
						cause: { code: '40001', originalCode: '40001' },
					},
				},
			}),
		).toBe(true);
		expect(
			isPrismaWriteConflict({
				message: 'Transaction failed due to a write conflict or a deadlock. Please retry your transaction',
			}),
		).toBe(true);
		expect(isPrismaWriteConflict({ code: 'P2025', message: 'Record not found' })).toBe(false);
	});

	it('retries a write conflict until the operation succeeds', async () => {
		let attempts = 0;
		const operation = async () => {
			attempts++;
			if (attempts === 1) throw { code: 'P2034' };
			if (attempts === 2) throw { cause: { code: '40P01' } };
			return 'updated';
		};

		await expect(
			retryPrismaWriteConflict(operation, {
				operationName: 'test update',
				initialDelayMs: 0,
			}),
		).resolves.toBe('updated');
		expect(attempts).toBe(3);
	});

	it('does not retry unrelated errors', async () => {
		const error = new Error('Database is unavailable');
		let attempts = 0;
		const operation = async () => {
			attempts++;
			throw error;
		};

		await expect(
			retryPrismaWriteConflict(operation, {
				operationName: 'test update',
				initialDelayMs: 0,
			}),
		).rejects.toBe(error);
		expect(attempts).toBe(1);
	});

	it('stops after the configured number of attempts', async () => {
		const error = { code: 'P2034' };
		let attempts = 0;
		const operation = async () => {
			attempts++;
			throw error;
		};

		await expect(
			retryPrismaWriteConflict(operation, {
				operationName: 'test update',
				maxAttempts: 3,
				initialDelayMs: 0,
			}),
		).rejects.toBe(error);
		expect(attempts).toBe(3);
	});
});
