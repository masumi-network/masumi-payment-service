import { PrismaClient } from '@prisma/client';
import { logger } from '../logger';

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

export const prisma = new PrismaClient({
  //log: ["query", "info", "warn", "error"]
  datasources: {
    db: {
      url: getDatabaseUrlWithTimeouts(),
    },
  },
});

export async function cleanupDB() {
  await prisma.$disconnect();
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
