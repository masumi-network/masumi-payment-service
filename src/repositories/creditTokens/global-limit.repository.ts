import { prisma } from '@/utils/db';
import { Prisma } from '@/generated/prisma/client';
import { InsufficientFundsError } from '@/utils/errors/insufficient-funds-error';
import { CONSTANTS } from '@/utils/config';

export async function checkGlobalSpendLimitOrThrow({
	apiKeyId,
	estimatedLovelace,
}: {
	apiKeyId: string;
	estimatedLovelace: bigint;
}): Promise<void> {
	await prisma.$transaction(
		async (tx) => {
			const apiKey = await tx.apiKey.findUnique({
				where: { id: apiKeyId },
				select: { globalSpendLimit: true, totalADASpent: true },
			});
			if (!apiKey || apiKey.globalSpendLimit === null) return;
			if (apiKey.totalADASpent + estimatedLovelace > apiKey.globalSpendLimit) {
				throw new InsufficientFundsError(`Global spend limit exceeded for api key: ${apiKeyId}`);
			}
			// Reserve the estimated fee atomically so concurrent calls see updated totalADASpent
			await tx.apiKey.update({
				where: { id: apiKeyId },
				data: { totalADASpent: { increment: estimatedLovelace } },
			});
		},
		{
			isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
			timeout: CONSTANTS.TRANSACTION_TIMEOUTS.SERIALIZABLE,
			maxWait: CONSTANTS.TRANSACTION_TIMEOUTS.SERIALIZABLE,
		},
	);
}
