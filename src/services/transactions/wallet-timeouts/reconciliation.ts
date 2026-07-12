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
	lastCheckedAt,
	invalidHereafterSlot,
	currentSlot,
	graceSlots = 60,
}: {
	lastCheckedAt: Date | null;
	invalidHereafterSlot: bigint | null;
	currentSlot: number;
	graceSlots?: number;
}): boolean {
	if (lastCheckedAt === null || invalidHereafterSlot === null) {
		return false;
	}

	return BigInt(currentSlot) > invalidHereafterSlot + BigInt(graceSlots);
}
