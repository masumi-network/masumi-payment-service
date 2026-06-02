import { prisma } from '@masumi/payment-core/db';
import { z } from '@masumi/payment-core/zod';
import { getSwapTransactionsSchemaInput } from './schemas';

export type SwapTransactionsQueryInput = z.infer<typeof getSwapTransactionsSchemaInput>;

export async function getSwapTransactionsForWallet(hotWalletId: string, input: SwapTransactionsQueryInput) {
	return prisma.swapTransaction.findMany({
		where: {
			hotWalletId,
		},
		orderBy: { createdAt: 'desc' },
		cursor: input.cursorId ? { id: input.cursorId } : undefined,
		take: input.limit,
	});
}

export type SwapTransactionRecord = Awaited<ReturnType<typeof getSwapTransactionsForWallet>>[number];
