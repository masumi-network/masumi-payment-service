import { describe, expect, it } from '@jest/globals';
import { readFile } from 'node:fs/promises';

describe('transaction report txHash index migration', () => {
	it('creates the index with one idempotent concurrent statement', async () => {
		const migration = await readFile(
			new URL('../../../prisma/migrations/20260824160000_add_transaction_tx_hash_index/migration.sql', import.meta.url),
			'utf8',
		);

		expect(migration.trim()).toBe(
			'CREATE INDEX CONCURRENTLY IF NOT EXISTS "Transaction_txHash_idx" ON "Transaction"("txHash");',
		);
		expect(migration).not.toMatch(/DROP INDEX/);
		expect(migration).not.toMatch(/\b(?:BEGIN|COMMIT)\b/);
	});
});
