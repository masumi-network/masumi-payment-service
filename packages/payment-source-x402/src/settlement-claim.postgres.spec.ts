import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import { Pool, type PoolClient } from 'pg';

const databaseUrl = process.env.X402_CLAIM_DATABASE_URL;
const describePostgres = databaseUrl == null ? describe.skip : describe;
const schemaName = `x402_claim_${randomUUID().replaceAll('-', '')}`;
const qualifiedAttempts = `"${schemaName}"."X402PaymentAttempt"`;

type ErrorWithCode = { code?: unknown };

function errorCode(result: PromiseSettledResult<unknown>): string | undefined {
	if (result.status !== 'rejected' || result.reason == null || typeof result.reason !== 'object') return undefined;
	const code = (result.reason as ErrorWithCode).code;
	return typeof code === 'string' ? code : undefined;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
	await client.query('ROLLBACK').catch(() => undefined);
}

describePostgres('x402 active settlement claim (PostgreSQL)', () => {
	let pool: Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(`CREATE SCHEMA "${schemaName}"`);
		await pool.query(`
			CREATE TABLE ${qualifiedAttempts} (
				"id" TEXT PRIMARY KEY,
				"paymentPayloadHash" TEXT,
				"direction" TEXT NOT NULL,
				"status" TEXT NOT NULL
			)
		`);
		const migrationSql = await readFile(
			new URL(
				'../../../prisma/migrations/20260712000000_add_x402_active_settlement_claim/migration.sql',
				import.meta.url,
			),
			'utf8',
		);
		const migrationClient = await pool.connect();
		try {
			await migrationClient.query(`SET search_path TO "${schemaName}"`);
			await migrationClient.query(migrationSql);
		} finally {
			migrationClient.release();
		}
	});

	afterAll(async () => {
		await pool.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
		await pool.end();
	});

	it('allows only one concurrent active attempt and releases the claim on Failed', async () => {
		const payloadHash = 'a'.repeat(64);
		const insert = (id: string) =>
			pool.query(
				`INSERT INTO ${qualifiedAttempts} ("id", "paymentPayloadHash", "direction", "status") VALUES ($1, $2, $3, $4)`,
				[id, payloadHash, 'InboundSettle', 'Verified'],
			);

		const results = await Promise.allSettled([insert('attempt-a'), insert('attempt-b')]);
		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
		expect(results.map(errorCode).filter((code) => code === '23505')).toHaveLength(1);

		await pool.query(`UPDATE ${qualifiedAttempts} SET "status" = 'Failed' WHERE "paymentPayloadHash" = $1`, [
			payloadHash,
		]);
		await expect(insert('attempt-retry')).resolves.toBeDefined();
		await pool.query(`UPDATE ${qualifiedAttempts} SET "status" = 'Settled' WHERE "id" = 'attempt-retry'`);
		await expect(insert('attempt-after-settled')).rejects.toMatchObject({ code: '23505' });
		await expect(
			pool.query(
				`INSERT INTO ${qualifiedAttempts} ("id", "paymentPayloadHash", "direction", "status") VALUES ($1, $2, $3, $4)`,
				['attempt-replay', payloadHash, 'InboundSettle', 'Replayed'],
			),
		).resolves.toBeDefined();
	});

	it('makes an advisory-lock waiter observe the winner with ReadCommitted snapshots', async () => {
		const payloadHash = 'b'.repeat(64);
		const lockKey = BigInt.asIntN(64, BigInt(`0x${payloadHash.slice(0, 16)}`));
		const winner = await pool.connect();
		const waiter = await pool.connect();
		try {
			await winner.query('BEGIN ISOLATION LEVEL READ COMMITTED');
			await waiter.query('BEGIN ISOLATION LEVEL READ COMMITTED');
			await winner.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
			await winner.query(
				`INSERT INTO ${qualifiedAttempts} ("id", "paymentPayloadHash", "direction", "status") VALUES ($1, $2, $3, $4)`,
				['attempt-winner', payloadHash, 'InboundSettle', 'Verified'],
			);

			const waiterLock = waiter.query('SELECT pg_advisory_xact_lock($1)', [lockKey]);
			await winner.query('COMMIT');
			await waiterLock;
			const observed = await waiter.query<{ count: string }>(
				`SELECT COUNT(*)::text AS count FROM ${qualifiedAttempts} WHERE "paymentPayloadHash" = $1`,
				[payloadHash],
			);
			expect(observed.rows[0]?.count).toBe('1');
			await waiter.query('COMMIT');
		} finally {
			await rollbackQuietly(winner);
			await rollbackQuietly(waiter);
			winner.release();
			waiter.release();
		}
	});
});
