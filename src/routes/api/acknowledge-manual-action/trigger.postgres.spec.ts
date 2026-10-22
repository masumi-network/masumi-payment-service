import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { Pool, type PoolClient } from 'pg';

// Needs a database with every migration applied (pnpm run prisma:migrate).
const databaseUrl = process.env.ACK_TRIGGER_DATABASE_URL;
const describePostgres = databaseUrl == null ? describe.skip : describe;

describePostgres('manual-action acknowledgement trigger (PostgreSQL)', () => {
	let pool: Pool;
	let client: PoolClient;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		client = await pool.connect();
		// Every row this spec writes is rolled back.
		await client.query('BEGIN');
	});

	afterAll(async () => {
		await client.query('ROLLBACK');
		client.release();
		await pool.end();
	});

	async function insertAcknowledged(table: 'PaymentActionData' | 'PurchaseActionData', id: string) {
		await client.query(
			`INSERT INTO "${table}" ("id", "updatedAt", "requestedAction", "errorType", "errorNote", "manualActionAcknowledgedAt")
			 VALUES ($1, now(), 'WaitingForManualAction', 'Unknown', 'first error', now())`,
			[id],
		);
	}

	async function readAck(table: string, id: string): Promise<Date | null> {
		const { rows } = await client.query<{ manualActionAcknowledgedAt: Date | null }>(
			`SELECT "manualActionAcknowledgedAt" FROM "${table}" WHERE "id" = $1`,
			[id],
		);
		return rows[0].manualActionAcknowledgedAt;
	}

	it.each(['PaymentActionData', 'PurchaseActionData'] as const)(
		'%s: a new error written in place clears the acknowledgement',
		async (table) => {
			await insertAcknowledged(table, `${table}-note`);
			await client.query(`UPDATE "${table}" SET "errorNote" = 'second error' WHERE "id" = $1`, [`${table}-note`]);
			expect(await readAck(table, `${table}-note`)).toBeNull();
		},
	);

	it.each(['PaymentActionData', 'PurchaseActionData'] as const)(
		'%s: an unrelated column update keeps the acknowledgement',
		async (table) => {
			await insertAcknowledged(table, `${table}-keep`);
			await client.query(`UPDATE "${table}" SET "submittedTxHash" = 'abc' WHERE "id" = $1`, [`${table}-keep`]);
			expect(await readAck(table, `${table}-keep`)).not.toBeNull();
		},
	);
});
