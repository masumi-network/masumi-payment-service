import { FundDistributionStatus, HotWalletType } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import createHttpError from 'http-errors';

/**
 * Refuse to retire target wallets that have a distribution in flight, and
 * cancel the ones that are merely queued.
 *
 * The caller MUST soft-delete the wallets in this same Serializable
 * transaction. That is what makes the check meaningful: a batch claim either
 * wins first (and this throws 409) or sees inactive targets. Run as two
 * statements on the base client the steps race, and a top-up can be signed and
 * broadcast to a wallet between the check passing and the delete landing.
 *
 * The `tx` type CANNOT enforce this. `Prisma.TransactionClient` is
 * `Omit<PrismaClient, '$connect'|'$disconnect'|'$on'|'$use'|'$extends'>` — it
 * keeps `$transaction`, so the base client is structurally identical here and
 * `prepareTargetWalletRemoval(prisma, ...)` type-checks. (Branding on the
 * absence of `$transaction` does not work either: the intersection collapses to
 * `never` and every call errors.) So this is a review-time invariant — check the
 * call site, not the signature.
 */
export async function prepareTargetWalletRemoval(
	tx: Prisma.TransactionClient,
	params: { paymentSourceId: string; walletIds: string[] },
): Promise<void> {
	const { paymentSourceId, walletIds } = params;
	if (walletIds.length === 0) return;

	const inFlightTopups = await tx.fundDistributionRequest.count({
		where: {
			targetWalletId: { in: walletIds },
			TargetWallet: { paymentSourceId, deletedAt: null },
			OR: [
				{ status: FundDistributionStatus.Submitted },
				{ status: FundDistributionStatus.Pending, transactionId: { not: null } },
			],
		},
	});
	if (inFlightTopups > 0) {
		throw createHttpError(409, 'Cannot remove a wallet while a fund distribution is in flight');
	}

	// Unclaimed requests have not been signed and are safe to cancel. The caller
	// soft-deletes the wallets in this same Serializable transaction, so a batch
	// claim either wins first (and blocks removal) or sees inactive targets.
	await tx.fundDistributionRequest.updateMany({
		where: {
			targetWalletId: { in: walletIds },
			TargetWallet: { paymentSourceId, deletedAt: null },
			status: FundDistributionStatus.Pending,
			transactionId: null,
		},
		data: {
			status: FundDistributionStatus.Failed,
			error: 'Distribution cancelled because the target wallet was removed',
		},
	});
}

export async function retirePaymentSourceFundDistributions(
	tx: Prisma.TransactionClient,
	paymentSourceId: string,
): Promise<void> {
	// Keep an active treasury discoverable. Operators may soft-delete a Funding
	// wallet through the existing wallet-removal flow; once it is retired this
	// guard no longer applies and the parent source can be deleted.
	const activeFundWalletCount = await tx.hotWallet.count({
		where: {
			paymentSourceId,
			type: HotWalletType.Funding,
			deletedAt: null,
		},
	});
	if (activeFundWalletCount > 0) {
		throw createHttpError(409, 'Remove the fund wallet before deleting its payment source');
	}

	// Stop new claims while leaving submitted/claimed rows intact for the
	// unconditional reconciliation and confirmation phases.
	await tx.fundDistributionConfig.updateMany({
		where: { HotWallet: { paymentSourceId, deletedAt: null } },
		data: { enabled: false },
	});
	await tx.fundDistributionRequest.updateMany({
		where: {
			FundWallet: { paymentSourceId },
			status: FundDistributionStatus.Pending,
			transactionId: null,
		},
		data: {
			status: FundDistributionStatus.Failed,
			error: 'Distribution cancelled because the payment source was deleted',
		},
	});
}
