import { X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { buildX402AttemptWhere, X402AttemptFilterInput } from './attempt-filters';
import { buildX402WalletCustodyWhere, type X402WalletCustodyScope } from './custody';

export async function countX402ManagedWallets(input?: {
	type?: X402EvmWalletType;
	custodyScope?: X402WalletCustodyScope;
}) {
	return prisma.x402EvmWallet.count({
		where: {
			deletedAt: null,
			type: input?.type,
			...buildX402WalletCustodyWhere(input?.custodyScope ?? null),
		},
	});
}

export async function countX402PaymentAttempts(input?: X402AttemptFilterInput) {
	return prisma.x402PaymentAttempt.count({
		where: buildX402AttemptWhere(input ?? {}),
	});
}

export async function countX402Settlements(input?: { caip2Network?: string; success?: boolean }) {
	return prisma.x402Settlement.count({
		where: { caip2Network: input?.caip2Network, success: input?.success },
	});
}
