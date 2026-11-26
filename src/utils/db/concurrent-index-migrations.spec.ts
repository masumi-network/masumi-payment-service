import { describe, expect, it } from '@jest/globals';
import { readdir, readFile } from 'node:fs/promises';

const migrationsDir = new URL('../../../prisma/migrations/', import.meta.url);

// The whole executable part of the file, and nothing else: one statement, no
// IF NOT EXISTS, no comment, quote or dollar sign that could hide a second one.
// Prisma wraps a migration in a transaction unless the whole file is a single
// CONCURRENTLY statement, and Postgres rejects CONCURRENTLY there.
const SINGLE_CONCURRENT_INDEX =
	/^CREATE\s+INDEX\s+CONCURRENTLY\s+"\w+"\s+ON\s+"\w+"\s*\(\s*"\w+"(\s*,\s*"\w+")*\s*\)\s*;$/i;

// Drop whole comment lines only. Postgres ends a line comment at \r or \n, so
// split on both. Anything else that looks like a comment stays and fails the
// strict pattern above, so an unusual file fails loudly instead of passing.
function executableSql(migration: string): string {
	return migration
		.split(/\r\n|\r|\n/)
		.filter((line) => !line.trimStart().startsWith('--'))
		.join('\n')
		.trim();
}

// In scope: every file with the DROP INDEX CONCURRENTLY recovery note, so
// removing the keyword from the statement still fails, and every file that runs
// CONCURRENTLY, so a file without the note is still checked. Migrations that
// only explain in comments why they skip CONCURRENTLY match neither.
function isConcurrentIndexMigration(migration: string): boolean {
	return /DROP INDEX CONCURRENTLY/i.test(migration) || /CONCURRENTLY/i.test(executableSql(migration));
}

async function loadConcurrentMigrations(): Promise<Array<{ name: string; sql: string }>> {
	const entries = await readdir(migrationsDir, { withFileTypes: true });
	const migrations = await Promise.all(
		entries
			.filter((entry) => entry.isDirectory())
			.map(async (entry) => ({
				name: entry.name,
				raw: await readFile(new URL(`${entry.name}/migration.sql`, migrationsDir), 'utf8'),
			})),
	);
	return migrations
		.filter((migration) => isConcurrentIndexMigration(migration.raw))
		.map(({ name, raw }) => ({ name, sql: executableSql(raw) }));
}

describe('concurrent index migrations', () => {
	const build = 'CREATE INDEX CONCURRENTLY "T_c_idx" ON "T"("c");';
	const note = '-- Recovery:\n--   DROP INDEX CONCURRENTLY "T_c_idx";\n';

	it('rejects files that hide a second statement or drop the safeguards', () => {
		// Each appended snippet once passed an earlier version of this guard.
		const rejected = [
			'\n-- /*\nSELECT 1;\n-- */',
			'\n/* a -- b */\nANALYZE "T";\n/* end */',
			'\n/* outer /* inner */ -- x */ ANALYZE "T";',
			'\n-- after deploy\rANALYZE "T";',
			'\nANALYZE "T";',
		];
		for (const suffix of rejected) {
			expect({ suffix, sql: executableSql(note + build + suffix) }).not.toEqual({
				suffix,
				sql: expect.stringMatching(SINGLE_CONCURRENT_INDEX),
			});
		}
		for (const sql of [
			'CREATE INDEX "T_c_idx" ON "T"("c");',
			'CREATE INDEX CONCURRENTLY IF NOT EXISTS "T_c_idx" ON "T"("c");',
		]) {
			expect(sql).not.toMatch(SINGLE_CONCURRENT_INDEX);
		}
		expect(executableSql(note + build)).toMatch(SINGLE_CONCURRENT_INDEX);
		expect(executableSql(`${note}CREATE INDEX CONCURRENTLY "T_c_idx"\n  ON "T"("a", "b");`)).toMatch(
			SINGLE_CONCURRENT_INDEX,
		);
	});

	it('checks a concurrent build even without the recovery note', () => {
		expect(isConcurrentIndexMigration(`${build}\nANALYZE "T";`)).toBe(true);
		expect(isConcurrentIndexMigration(note + 'CREATE INDEX "T_c_idx" ON "T"("c");')).toBe(true);
		expect(isConcurrentIndexMigration('-- CONCURRENTLY is deliberately NOT used.\nCREATE INDEX "x" ON "T"("c");')).toBe(
			false,
		);
	});

	it('keeps each CONCURRENTLY migration to exactly one CREATE INDEX CONCURRENTLY statement', async () => {
		const migrations = await loadConcurrentMigrations();

		// Guards against a wrong path silently checking nothing.
		expect(migrations.length).toBeGreaterThanOrEqual(22);
		for (const { name, sql } of migrations) {
			expect({ name, sql }).toEqual({ name, sql: expect.stringMatching(SINGLE_CONCURRENT_INDEX) });
		}
	});
});
