import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

console.log('DEBUG: DATABASE_URL from process.env:', process.env.DATABASE_URL ? 'Found' : 'Missing');

export default defineConfig({
    schema: 'schema.prisma',
    migrations: {
        path: 'migrations',
        seed: 'tsx prisma/seed.ts',
    },
    datasource: {
        url: env('DATABASE_URL'),
        shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL ? env('SHADOW_DATABASE_URL') : undefined,
    },
});
