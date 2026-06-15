import { X402EvmWalletType, X402PaymentDirection, X402PaymentStatus, prisma } from '@masumi/payment-core/db';

export async function countX402ManagedWallets(input?: { type?: X402EvmWalletType }) {
	return prisma.x402EvmWallet.count({ where: { deletedAt: null, type: input?.type } });
}

export async function countX402PaymentAttempts(input?: {
	status?: X402PaymentStatus;
	direction?: X402PaymentDirection;
	caip2Network?: string;
}) {
	return prisma.x402PaymentAttempt.count({
		where: { status: input?.status, direction: input?.direction, caip2Network: input?.caip2Network },
	});
}

export async function countX402Settlements(input?: { caip2Network?: string; success?: boolean }) {
	return prisma.x402Settlement.count({
		where: { caip2Network: input?.caip2Network, success: input?.success },
	});
}
