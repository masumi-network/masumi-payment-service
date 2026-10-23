import { type Prisma, TransactionStatus } from '@/generated/prisma/client';

export type NodeFundingBaseline = { address: string; confirmedTransferIds: string[] };
type FundingHistoryReader = Pick<Prisma.TransactionClient, 'walletFundTransfer'>;

/** Capture before chain reads so a later confirmation cannot inherit stale balance evidence. */
export async function captureNodeFundingBaseline(
	db: FundingHistoryReader,
	address: string,
): Promise<NodeFundingBaseline> {
	const confirmed = await db.walletFundTransfer.findMany({
		where: { toAddress: address, status: TransactionStatus.Confirmed },
		select: { id: true },
	});
	return { address, confirmedTransferIds: confirmed.map(({ id }) => id) };
}

/**
 * Read inside the Serializable transaction that deletes the participant and key.
 * Funding reads that participant before inserting a transfer. These reciprocal
 * reads and writes preserve SSI conflicts across replicas for overlapping claims.
 * A retry must recheck this guard against the same baseline.
 */
export async function hasUnsettledNodeFunding(
	tx: FundingHistoryReader,
	baseline: NodeFundingBaseline,
): Promise<boolean> {
	const incoming = await tx.walletFundTransfer.findFirst({
		where: {
			toAddress: baseline.address,
			OR: [
				...recentlySentTo().OR,
				{ status: TransactionStatus.Confirmed, id: { notIn: baseline.confirmedTransferIds } },
			],
		},
		select: { id: true },
	});
	return incoming !== null;
}

/**
 * How long a transfer counts as still in flight after it stops being Pending.
 *
 * Guarding on Pending alone was not enough. A transfer confirms in our database
 * a little before the chain indexer reflects it, and inside that gap the guard
 * sees nothing pending and the balance still reads zero, so a second transfer
 * goes out. Every node opened so far was funded twice, fifty seconds apart, for
 * exactly this reason.
 *
 * Generous on purpose: paying a node twice costs real ADA, while waiting a few
 * extra minutes to top up a node that is already funded costs nothing.
 */
const RECENT_TRANSFER_WINDOW_MS = 15 * 60 * 1000;
/**
 * Anything sent to this address that may still land.
 *
 * Terminal failures are excluded: a transfer that definitively did not happen
 * must not block the retry that replaces it.
 *
 * The two live statuses are bounded differently, and deliberately. A `Pending`
 * transfer has not been submitted yet, so age tells us nothing about it — the
 * submitter only picks up rows whose hot wallet is free, and that wallet is the
 * same one doing this head's L2 locks and batch payments, so it is routinely
 * busy for far longer than the window. Bounding `Pending` by age meant a
 * transfer that had been waiting sixteen minutes stopped counting, a second
 * 30 ADA transfer was created, then a third, and every one of them submitted at
 * once when the wallet finally came free. Only `Confirmed` needs the window,
 * for the gap between our own confirmation and the chain indexer reflecting it.
 */
export function recentlySentTo() {
	// Measured from the confirmation, not from the row's creation. The two are
	// far apart for exactly the reason the paragraph above gives: the submitter
	// waits for a hot wallet that is busy doing this head's L2 work, so a
	// transfer routinely sits `Pending` for longer than the whole window and is
	// already outside it the instant it confirms. That put the indexing gap back
	// where it started — the next cycle reads a zero balance, sees nothing in
	// flight and sends a second 30 ADA — and worse, `withdrawNodeFunds` shares
	// this helper: a sweep in that gap reports `dust`, which is a settled code,
	// and the participant and its only signing key are deleted while 30 ADA is
	// still on its way to the node's address.
	const cutoff = new Date(Date.now() - RECENT_TRANSFER_WINDOW_MS);
	return {
		OR: [
			{ status: TransactionStatus.Pending },
			{
				status: TransactionStatus.Confirmed,
				// `createdAt` remains the fallback for a row confirmed by a path that
				// never stamped `lastCheckedAt`.
				OR: [{ lastCheckedAt: { gte: cutoff } }, { lastCheckedAt: null, createdAt: { gte: cutoff } }],
			},
		],
	};
}
