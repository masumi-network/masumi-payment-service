import { logger } from '@/utils/logger';

const RETRYABLE_DATABASE_ERROR_CODES = new Set(['P2034', 'P2028', '40001', '40P01', '25001']);
const WRITE_CONFLICT_MESSAGE = 'transaction failed due to a write conflict or a deadlock';

type ErrorWithCause = {
	code?: unknown;
	originalCode?: unknown;
	message?: unknown;
	cause?: unknown;
	meta?: unknown;
	driverAdapterError?: unknown;
};

function asErrorShape(value: unknown): ErrorWithCause | null {
	return typeof value === 'object' && value !== null ? (value as ErrorWithCause) : null;
}

export function isPrismaWriteConflict(error: unknown): boolean {
	const visitedErrors = new Set<unknown>();
	const errorsToInspect: unknown[] = [error];

	while (errorsToInspect.length > 0) {
		const currentError = errorsToInspect.shift();
		const errorWithCause = asErrorShape(currentError);
		if (errorWithCause == null || visitedErrors.has(currentError)) {
			continue;
		}
		visitedErrors.add(currentError);

		const errorCodes = [errorWithCause.code, errorWithCause.originalCode];
		if (errorCodes.some((code) => typeof code === 'string' && RETRYABLE_DATABASE_ERROR_CODES.has(code))) {
			return true;
		}

		if (
			typeof errorWithCause.message === 'string' &&
			errorWithCause.message.toLowerCase().includes(WRITE_CONFLICT_MESSAGE)
		) {
			return true;
		}

		errorsToInspect.push(errorWithCause.cause, errorWithCause.meta, errorWithCause.driverAdapterError);
	}

	return false;
}

export async function retryPrismaWriteConflict<T>(
	operation: () => Promise<T>,
	options: {
		operationName: string;
		maxAttempts?: number;
		initialDelayMs?: number;
		maxDelayMs?: number;
		random?: () => number;
	},
): Promise<T> {
	// Nine total attempts matches the refactored service's contention budget:
	// one initial try plus eight retries, with full-jitter exponential backoff.
	const maxAttempts = options.maxAttempts ?? 9;
	const initialDelayMs = options.initialDelayMs ?? 100;
	const maxDelayMs = options.maxDelayMs ?? 5000;
	const random = options.random ?? Math.random;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (!isPrismaWriteConflict(error) || attempt === maxAttempts) {
				throw error;
			}

			const backoffDelayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
			const delayMs = Math.floor(backoffDelayMs * random());
			logger.warn('Retrying database operation after a write conflict', {
				operation: options.operationName,
				attempt,
				maxAttempts,
				delayMs,
				error,
			});

			await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}

	throw new Error('Unreachable database retry state');
}
