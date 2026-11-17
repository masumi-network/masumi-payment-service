import 'dotenv/config';
import { defineConfig } from 'prisma/config';

console.log('DEBUG: DATABASE_URL from process.env:', process.env.DATABASE_URL ? 'Found' : 'Missing');
// `prisma generate` needs no database, so it may run with the placeholder URL. Commands that connect must fail
// here instead, or a missing DATABASE_URL shows up only as a connection error against localhost.
// `migrate diff` and `--help` can also run without a database.
const DATABASE_COMMANDS = ['migrate', 'db', 'studio'];
const OFFLINE_ARGS = ['diff', '--help', '-h'];
if (
	!process.env.DATABASE_URL &&
	process.argv.some((arg) => DATABASE_COMMANDS.includes(arg)) &&
	!process.argv.some((arg) => OFFLINE_ARGS.includes(arg))
) {
	throw new Error('DATABASE_URL is not set');
}
const databaseUrl = process.env.DATABASE_URL || 'postgresql://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
	schema: '.',
	migrations: {
		path: 'migrations',
		seed: 'tsx prisma/seed.ts',
	},
	datasource: {
		url: databaseUrl,
		shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
	},
});
