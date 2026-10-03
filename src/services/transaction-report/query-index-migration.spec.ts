import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('transaction report txHash index migration', () => {
	it('creates the index with one concurrent statement and no IF NOT EXISTS', async () => {
		const migration = await readFile(
			new URL('../../../prisma/migrations/20260824160000_add_transaction_tx_hash_index/migration.sql', import.meta.url),
			'utf8',
		);
		// Prisma runs a migration inside a transaction unless the whole file is a
		// single CONCURRENTLY statement, so the guard has to read the executable
		// part only. The recovery note in the comments names DROP INDEX on purpose.
		const statements = migration
			.split('\n')
			.filter((line) => !line.trimStart().startsWith('--'))
			.join('\n')
			.trim();

		expect(statements).toBe('CREATE INDEX CONCURRENTLY "Transaction_txHash_idx" ON "Transaction"("txHash");');
		// IF NOT EXISTS would skip an invalid index left by a failed build and
		// report success for ever while the planner never used it.
		expect(statements).not.toMatch(/IF NOT EXISTS/);
		expect(statements).not.toMatch(/DROP INDEX/);
		expect(statements).not.toMatch(/\b(?:BEGIN|COMMIT)\b/);
	});
});
