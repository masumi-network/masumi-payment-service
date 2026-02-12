import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool, PoolConfig } from 'pg';
import { logger } from '../logger';
import fs from 'fs';
import path from 'path';

const CERT_PATH = path.resolve('certs/ca-certificate.crt');

// Write CA certificate from DATABASE_CA_CERT env var to disk so sslrootcert can reference it
const writeCaCertificate = () => {
	const cert = process.env.DATABASE_CA_CERT;
	if (!cert) {
		// Delete stale certificate file if it exists
		if (fs.existsSync(CERT_PATH)) {
			fs.unlinkSync(CERT_PATH);
		}
		return;
	}
	const pemContent = cert.replace(/\\n/g, '\n');
	fs.mkdirSync(path.dirname(CERT_PATH), { recursive: true });
	fs.writeFileSync(CERT_PATH, pemContent);
};

writeCaCertificate();

// Add timeout parameters to DATABASE_URL if not already present
const getDatabaseUrlWithTimeouts = () => {
	const baseUrl = process.env.DATABASE_URL!;
	const url = new URL(baseUrl);
	//override the db timeout parameters if they are not already set
	if (!url.searchParams.has('statement_timeout')) {
		url.searchParams.set('statement_timeout', '15000');
	}
	if (!url.searchParams.has('connection_limit')) {
		url.searchParams.set('connection_limit', '5');
	}
	if (!url.searchParams.has('pool_timeout')) {
		url.searchParams.set('pool_timeout', '20');
	}
	if (!url.searchParams.has('connect_timeout')) {
		url.searchParams.set('connect_timeout', '10');
	}
	// Add sslrootcert if CA cert file exists
	if (!url.searchParams.has('sslrootcert') && fs.existsSync(CERT_PATH)) {
		url.searchParams.set('sslrootcert', CERT_PATH);
	}
	return url.toString();
};

// Parse connection string to extract pool configuration
const getPoolConfig = () => {
	const connectionString = getDatabaseUrlWithTimeouts();
	const url = new URL(connectionString);

	// Extract connection_limit from URL params (default: 5)
	const connectionLimit = parseInt(url.searchParams.get('connection_limit') || '5', 10);

	// Extract connect_timeout from URL params (default: 10 seconds = 10000ms)
	const connectTimeout = parseInt(url.searchParams.get('connect_timeout') || '10', 10) * 1000;

	// Extract pool_timeout from URL params (default: 20 seconds = 20000ms)
	const poolTimeout = parseInt(url.searchParams.get('pool_timeout') || '20', 10) * 1000;
	return {
		connectionString,
		max: connectionLimit, // Maximum number of clients in the pool
		min: 1, // Minimum number of clients in the pool
		idleTimeoutMillis: poolTimeout, // Close idle clients after this many milliseconds
		connectionTimeoutMillis: connectTimeout, // Return an error after this many milliseconds if a connection cannot be established
	} as PoolConfig;
};

// Create a connection pool with configured settings
const pool = new Pool(getPoolConfig());

pool.on('error', (err) => {
	logger.error('Unexpected error on idle database client', {
		component: 'prisma',
		error: err instanceof Error ? err.message : String(err),
		stack: err instanceof Error ? err.stack : undefined,
	});
});

const adapter = new PrismaPg(pool);

// Create Prisma client with driver adapter
export const prisma = new PrismaClient({
	adapter,
});

export async function cleanupDB() {
	await prisma.$disconnect();
	await pool.end();
}

export async function initDB() {
	await prisma.$connect();

	const paymentSources = await prisma.paymentSource.aggregate({
		_count: true,
		where: {
			deletedAt: null,
		},
	});
	logger.info(`Found ${paymentSources._count} payment source${paymentSources._count == 1 ? '' : 's'}`);
	logger.info('Initialized database');
}
