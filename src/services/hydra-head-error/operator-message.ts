import { Prisma } from '@/generated/prisma/client';
import { logger } from '@masumi/payment-core/logger';

/**
 * What an operator is shown for a failure.
 *
 * A database error's own message is the invocation, an absolute path on the
 * server and an excerpt of the code around it. It was stored as the reason and
 * returned by the errors API, so a value the database could not hold ended in a
 * response that named a file on the server. The operator is told that the
 * database refused and under which code; the full error stays in the log.
 *
 * Every other error keeps its text: those are written for the person reading.
 */
export function describeErrorForOperator(error: unknown): string {
	if (isDatabaseError(error)) {
		logger.error('[HydraError] a database error was kept out of the operator-facing message', { error });
		const code = error instanceof Prisma.PrismaClientKnownRequestError ? ` (${error.code})` : '';
		return `the database rejected the write${code}`;
	}
	return error instanceof Error ? error.message : String(error);
}

function isDatabaseError(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError ||
		error instanceof Prisma.PrismaClientUnknownRequestError ||
		error instanceof Prisma.PrismaClientValidationError ||
		error instanceof Prisma.PrismaClientRustPanicError ||
		error instanceof Prisma.PrismaClientInitializationError
	);
}
