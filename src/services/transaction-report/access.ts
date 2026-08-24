import createHttpError from 'http-errors';
import { prisma } from '@masumi/payment-core/db';
import type { AuthContext } from '@masumi/payment-core/auth';
import { HotWalletType, type Prisma } from '@/generated/prisma/client';

export type ReportAccessClient = Pick<Prisma.TransactionClient, 'paymentSource' | 'hotWallet'>;

export const MAX_REPORT_FACET_ROWS = 10_000;

const paymentSourceSelect = {
	id: true,
	createdAt: true,
	network: true,
	paymentSourceType: true,
	smartContractAddress: true,
	feeRatePermille: true,
	deletedAt: true,
} as const;

const managedWalletSelect = {
	id: true,
	createdAt: true,
	paymentSourceId: true,
	type: true,
	walletAddress: true,
	walletVkey: true,
	collectionAddress: true,
	note: true,
	deletedAt: true,
} as const;

function notFound(): never {
	throw createHttpError(404, 'Not found');
}

export async function resolveAccessibleReportSource(
	ctx: AuthContext,
	paymentSourceId: string,
	database: ReportAccessClient = prisma,
) {
	const paymentSource = await database.paymentSource.findFirst({
		where: {
			id: paymentSourceId,
			network: { in: ctx.networkLimit },
		},
		select: paymentSourceSelect,
	});

	return paymentSource ?? notFound();
}

export async function resolveAuthorizedManagedWalletIds(
	ctx: AuthContext,
	paymentSourceId: string,
	requestedIds?: readonly string[],
	database: ReportAccessClient = prisma,
): Promise<string[] | null> {
	await resolveAccessibleReportSource(ctx, paymentSourceId, database);

	const uniqueRequestedIds = requestedIds == null ? null : Array.from(new Set(requestedIds));
	if (uniqueRequestedIds == null && ctx.walletScopeIds === null) return null;

	const candidateIds = uniqueRequestedIds ?? ctx.walletScopeIds ?? [];
	if (ctx.walletScopeIds !== null) {
		const walletScope = new Set(ctx.walletScopeIds);
		if (candidateIds.some((id) => !walletScope.has(id))) notFound();
	}

	if (candidateIds.length === 0) return [];
	const wallets = await database.hotWallet.findMany({
		where: {
			paymentSourceId,
			id: { in: candidateIds },
			type: { in: [HotWalletType.Selling, HotWalletType.Purchasing] },
		},
		select: { id: true },
	});
	const foundIds = new Set(wallets.map((wallet) => wallet.id));
	if (uniqueRequestedIds != null && uniqueRequestedIds.some((id) => !foundIds.has(id))) notFound();

	return candidateIds.filter((id) => foundIds.has(id));
}

export async function listAccessibleReportFacets(ctx: AuthContext) {
	const walletScopeFilter = ctx.walletScopeIds === null ? {} : { id: { in: ctx.walletScopeIds } };
	const [paymentSources, managedWallets] = await Promise.all([
		prisma.paymentSource.findMany({
			where: { network: { in: ctx.networkLimit } },
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			select: paymentSourceSelect,
			take: MAX_REPORT_FACET_ROWS + 1,
		}),
		prisma.hotWallet.findMany({
			where: {
				type: { in: [HotWalletType.Selling, HotWalletType.Purchasing] },
				PaymentSource: { network: { in: ctx.networkLimit } },
				...walletScopeFilter,
			},
			orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
			select: managedWalletSelect,
			take: MAX_REPORT_FACET_ROWS + 1,
		}),
	]);
	if (paymentSources.length > MAX_REPORT_FACET_ROWS || managedWallets.length > MAX_REPORT_FACET_ROWS) {
		throw createHttpError(413, `Report facets exceed ${MAX_REPORT_FACET_ROWS} rows`);
	}

	return { paymentSources, managedWallets };
}
