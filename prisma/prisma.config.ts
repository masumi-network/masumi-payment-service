import 'dotenv/config';
import { defineConfig } from 'prisma/config';

console.log('DEBUG: DATABASE_URL from process.env:', process.env.DATABASE_URL ? 'Found' : 'Missing');
const databaseUrl = process.env.DATABASE_URL || 'postgresql://placeholder:placeholder@localhost:5432/placeholder';

export default defineConfig({
    schema: 'schema.prisma',
    migrations: {
        path: 'migrations',
        seed: 'tsx prisma/seed.ts',
    },
    datasource: {
        url: databaseUrl,
        shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL || undefined,
    },
});
