import { logger } from '@/utils/logger';

const RETRYABLE_DATABASE_ERROR_CODES = new Set(['P2034', '40001', '40P01']);
const WRITE_CONFLICT_MESSAGE = 'transaction failed due to a write conflict or a deadlock';

type ErrorWithCause = {
	code?: unknown;
	message?: unknown;
	cause?: unknown;
};

export function isPrismaWriteConflict(error: unknown): boolean {
	const visitedErrors = new Set<unknown>();
	let currentError = error;

	while (typeof currentError === 'object' && currentError !== null && !visitedErrors.has(currentError)) {
		visitedErrors.add(currentError);
		const errorWithCause = currentError as ErrorWithCause;

		if (typeof errorWithCause.code === 'string' && RETRYABLE_DATABASE_ERROR_CODES.has(errorWithCause.code)) {
			return true;
		}

		if (
			typeof errorWithCause.message === 'string' &&
			errorWithCause.message.toLowerCase().includes(WRITE_CONFLICT_MESSAGE)
		) {
			return true;
		}

		currentError = errorWithCause.cause;
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
	const maxAttempts = options.maxAttempts ?? 5;
	const initialDelayMs = options.initialDelayMs ?? 50;
	const maxDelayMs = options.maxDelayMs ?? 1000;
	const random = options.random ?? Math.random;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (!isPrismaWriteConflict(error) || attempt === maxAttempts) {
				throw error;
			}

			const backoffDelayMs = Math.min(initialDelayMs * 2 ** (attempt - 1), maxDelayMs);
			const delayMs = Math.round(backoffDelayMs + backoffDelayMs * 0.25 * random());
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
