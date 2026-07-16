import { Prisma, X402EvmWalletType, prisma } from '@masumi/payment-core/db';
import { buildX402AttemptWhere, X402AttemptFilterInput } from './attempt-filters';
import { buildOwnerScopeWhere, type X402OwnerScope } from './internal';
import { getX402DatabaseNow } from './settle-lock';

export async function countX402ManagedWallets(input?: {
	type?: X402EvmWalletType;
	ownerScope?: X402OwnerScope;
	caip2NetworkLimit?: string[] | null;
}) {
	return prisma.x402EvmWallet.count({
		where: {
			deletedAt: null,
			type: input?.type,
			Network: input?.caip2NetworkLimit == null ? undefined : { caip2Id: { in: input.caip2NetworkLimit } },
			...buildOwnerScopeWhere(input?.ownerScope ?? null),
		},
	});
}

export async function countX402PaymentAttempts(input?: X402AttemptFilterInput) {
	const databaseNow = input?.filterNeedsManualAction === true ? await getX402DatabaseNow() : undefined;
	return prisma.x402PaymentAttempt.count({
		where: buildX402AttemptWhere(input ?? {}, databaseNow),
	});
}

export async function countX402Settlements(input?: {
	caip2Network?: string;
	success?: boolean;
	// Scopes settlements to those whose attempt was initiated by this API key (tenant isolation).
	apiKeyId?: string;
}) {
	// Network + the tenant scope are both carried by the linked attempt, not a settlement column.
	const paymentAttemptFilter: Prisma.X402PaymentAttemptWhereInput = {
		...(input?.apiKeyId != null ? { apiKeyId: input.apiKeyId } : {}),
		...(input?.caip2Network != null ? { Network: { caip2Id: input.caip2Network } } : {}),
	};
	return prisma.x402Settlement.count({
		where: {
			success: input?.success,
			PaymentAttempt: Object.keys(paymentAttemptFilter).length > 0 ? paymentAttemptFilter : undefined,
		},
	});
}
