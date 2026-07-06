import { prisma } from '@masumi/payment-core/db';
import { cursorPaginationArgs } from '@/utils/shared/queries';
import { AuthContext } from '@masumi/payment-core/auth';
import { HotWalletType } from '@/generated/prisma/client';
import { buildHotWalletScopeFilter } from '@/utils/shared/wallet-scope';
import { z } from '@masumi/payment-core/zod';
import { paymentSourceExtendedSchemaInput } from './schemas';

export type WalletCounts = { PurchasingWalletsCount: number; SellingWalletsCount: number };

/**
 * Active hot-wallet counts per payment source. Hot wallets are no longer
 * embedded in the response, so the UI relies on these aggregates for badges /
 * counts and fetches the wallets themselves lazily via GET /wallet/list. The
 * same wallet-scope filter as /wallet/list is applied so a scoped key's counts
 * never exceed the wallets it can actually load.
 */
export async function getWalletCountsByPaymentSource(
	paymentSourceIds: string[],
	walletScopeIds: AuthContext['walletScopeIds'],
): Promise<Map<string, WalletCounts>> {
	const counts = new Map<string, WalletCounts>(
		paymentSourceIds.map((id) => [id, { PurchasingWalletsCount: 0, SellingWalletsCount: 0 }]),
	);
	if (paymentSourceIds.length === 0) {
		return counts;
	}

	const grouped = await prisma.hotWallet.groupBy({
		by: ['paymentSourceId', 'type'],
		where: {
			paymentSourceId: { in: paymentSourceIds },
			deletedAt: null,
			...buildHotWalletScopeFilter(walletScopeIds),
		},
		_count: { _all: true },
	});

	for (const row of grouped) {
		const entry = counts.get(row.paymentSourceId) ?? { PurchasingWalletsCount: 0, SellingWalletsCount: 0 };
		if (row.type === HotWalletType.Selling) {
			entry.SellingWalletsCount = row._count._all;
		} else {
			entry.PurchasingWalletsCount = row._count._all;
		}
		counts.set(row.paymentSourceId, entry);
	}

	return counts;
}

export type PaymentSourceExtendedListQueryInput = z.infer<typeof paymentSourceExtendedSchemaInput>;

export const paymentSourceExtendedInclude = {
	AdminWallets: {
		orderBy: { order: 'asc' },
		select: { walletAddress: true, order: true },
	},
	FeeReceiverNetworkWallet: {
		select: { walletAddress: true },
	},
	PaymentSourceConfig: {
		select: { rpcProviderApiKey: true, rpcProvider: true },
	},
} as const;

export async function getPaymentSourceExtendedForQuery(
	input: PaymentSourceExtendedListQueryInput,
	networkLimit: AuthContext['networkLimit'],
) {
	// Optional single-network filter, still bounded by the key's networkLimit: a
	// requested network outside the limit yields an empty set (never widens access).
	const networks = input.network ? networkLimit.filter((allowed) => allowed === input.network) : networkLimit;
	return prisma.paymentSource.findMany({
		where: {
			network: {
				in: networks,
			},
			deletedAt: null,
		},
		orderBy: {
			createdAt: 'desc',
		},
		...cursorPaginationArgs(input.cursorId, input.take),
		include: paymentSourceExtendedInclude,
	});
}

export type PaymentSourceExtendedListRecord = Awaited<ReturnType<typeof getPaymentSourceExtendedForQuery>>[number];
