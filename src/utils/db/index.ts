import { PrismaClient } from '@/generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { logger } from '../logger';
import { recordPrismaDataTransfer } from '../metrics';

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
  return url.toString();
};

// Parse connection string to extract pool configuration
const getPoolConfig = () => {
  const connectionString = getDatabaseUrlWithTimeouts();
  const url = new URL(connectionString);

  // Extract connection_limit from URL params (default: 5)
  const connectionLimit = parseInt(
    url.searchParams.get('connection_limit') || '5',
    10,
  );

  // Extract connect_timeout from URL params (default: 10 seconds = 10000ms)
  const connectTimeout =
    parseInt(url.searchParams.get('connect_timeout') || '10', 10) * 1000;

  // Extract pool_timeout from URL params (default: 20 seconds = 20000ms)
  const poolTimeout =
    parseInt(url.searchParams.get('pool_timeout') || '20', 10) * 1000;

  return {
    connectionString,
    max: connectionLimit, // Maximum number of clients in the pool
    min: 1, // Minimum number of clients in the pool
    idleTimeoutMillis: poolTimeout, // Close idle clients after this many milliseconds
    connectionTimeoutMillis: connectTimeout, // Return an error after this many milliseconds if a connection cannot be established
  };
};

// Create a connection pool with configured settings
const pool = new Pool(getPoolConfig());

// Set up pool error handling
pool.on('error', (err) => {
  logger.error('Unexpected error on idle database client', {
    component: 'prisma',
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
});

// Helper function to calculate the size of data in bytes
const calculateDataSize = (data: unknown): number => {
  if (data === null || data === undefined) {
    return 0;
  }

  // For arrays, calculate size of each element
  if (Array.isArray(data)) {
    return (data as unknown[]).reduce<number>(
      (sum, item) => sum + calculateDataSize(item),
      0,
    );
  }

  // For objects, calculate size of all properties
  if (typeof data === 'object' && data !== null) {
    return (Object.values(data) as unknown[]).reduce<number>(
      (sum, value) => sum + calculateDataSize(value),
      0,
    );
  }

  // For primitives, estimate size
  if (typeof data === 'string') {
    // UTF-8 encoding: most characters are 1 byte, but some can be up to 4 bytes
    return Buffer.byteLength(data, 'utf8');
  }

  if (typeof data === 'number') {
    return 8; // 64-bit number
  }

  if (typeof data === 'boolean') {
    return 1;
  }

  if (data instanceof Date) {
    return 8; // Timestamp
  }

  if (data instanceof BigInt) {
    return 8; // BigInt representation
  }

  // For other types, serialize to JSON and measure
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf8');
  } catch {
    return 0;
  }
};

// Helper function to count rows in result
const countRows = (result: unknown): number => {
  if (Array.isArray(result)) {
    return result.length;
  }
  if (result && typeof result === 'object') {
    // For aggregate results like { _count: { ... } }
    if ('_count' in result) {
      return 1;
    }
    // For single object results
    return 1;
  }
  return result !== null && result !== undefined ? 1 : 0;
};

const adapter = new PrismaPg(pool);

// Create Prisma client with driver adapter
const basePrisma = new PrismaClient({
  adapter,
});

// Extend Prisma client with query middleware to measure data transfer
export const prisma = basePrisma.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const startTime = Date.now();
        const result = await query(args);
        const duration = Date.now() - startTime;

        // Calculate data size
        const dataSize = calculateDataSize(result);
        const rowCount = countRows(result);

        // Record metrics - using direct recording like apiRequestDuration
        const modelName = model || 'unknown';

        try {
          recordPrismaDataTransfer(modelName, operation, dataSize, rowCount, {
            duration_ms: duration,
          });
        } catch (error) {
          // Log but don't fail the query if metrics fail
          logger.error('Failed to record Prisma metrics', {
            component: 'prisma',
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            model: modelName,
            operation,
          });
        }

        // Optional: Log large transfers (configurable threshold, e.g., > 1MB)
        const sizeKB = dataSize / 1024;
        const sizeMB = sizeKB / 1024;
        if (sizeMB > 1) {
          logger.warn(
            `Large Prisma query: ${model || 'unknown'}.${operation} transferred ${sizeMB.toFixed(2)} MB (${rowCount} rows) in ${duration}ms`,
            {
              component: 'prisma',
              model: model || 'unknown',
              operation,
              size_bytes: dataSize,
              size_kb: sizeKB,
              size_mb: sizeMB,
              row_count: rowCount,
              duration_ms: duration,
            },
          );
        }

        return result;
      },
    },
  },
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
  logger.info(
    `Found ${paymentSources._count} payment source${paymentSources._count == 1 ? '' : 's'}`,
  );
  logger.info('Initialized database');
}
