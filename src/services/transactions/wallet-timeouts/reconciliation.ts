import { errorToString } from '@/utils/converter/error-string-convert';

export function isTransactionNotFoundError(error: unknown): boolean {
	const message = errorToString(error).toLowerCase();
	return (
		message.includes('transaction not found') ||
		message.includes('"status":404') ||
		message.includes('"status_code":404')
	);
}

export function shouldRequeueMissingTransaction({
	createdAt,
	lastCheckedAt,
	now,
	timeoutMs,
}: {
	createdAt: Date;
	lastCheckedAt: Date | null;
	now: Date;
	timeoutMs: number;
}): boolean {
	return lastCheckedAt !== null && createdAt.getTime() <= now.getTime() - timeoutMs;
}
