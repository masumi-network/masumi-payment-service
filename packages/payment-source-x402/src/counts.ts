import { X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { buildX402AttemptWhere, X402AttemptFilterInput } from './attempt-filters';

export async function countX402ManagedWallets(input?: { type?: X402EvmWalletType }) {
	return prisma.x402EvmWallet.count({ where: { deletedAt: null, type: input?.type } });
}

export async function countX402PaymentAttempts(input?: X402AttemptFilterInput) {
	return prisma.x402PaymentAttempt.count({
		where: buildX402AttemptWhere(input ?? {}),
	});
}

export async function countX402Settlements(input?: { caip2Network?: string; success?: boolean }) {
	return prisma.x402Settlement.count({
		// Network is now carried by the linked attempt's rail, not a settlement column.
		where: {
			success: input?.success,
			PaymentAttempt: input?.caip2Network != null ? { Network: { caip2Id: input.caip2Network } } : undefined,
		},
	});
}
