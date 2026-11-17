import { HydraHeadStatus, type Prisma } from '@/generated/prisma/client';
import { hasUnsettledHydraRequestState, unsettledL2TransactionWhere } from '../deletion-guard';

const FANOUT_TX_HASH_PATTERN = /^[0-9a-f]{64}$/;

export type PriorHeadBlocker = { kind: 'live'; status: HydraHeadStatus } | { kind: 'unsettled' } | { kind: 'handoffs' };

/**
 * Why a relation cannot get a new head yet, as far as the database shows, or
 * null when it can.
 *
 * createBoundHydraHead refuses on exactly this, inside its transaction. Callers
 * that ask before something is spent (an invite nonce, a node start) use the
 * same function, so their answer can never be stricter than head creation and
 * hold a pair back that head creation would allow, and never looser and burn a
 * nonce head creation then refuses. verifyPriorHydraFanouts adds the L1 half.
 */
export async function findPriorHeadBlocker(
	client: Prisma.TransactionClient,
	relation: Prisma.HydraRelationWhereInput,
): Promise<PriorHeadBlocker | null> {
	const heads = await client.hydraHead.findMany({
		where: {
			HydraRelation: relation,
			// A retired head can never reach Final; it no longer holds the relation.
			OR: [{ status: HydraHeadStatus.Final }, { retiredAt: null }],
		},
		select: {
			id: true,
			status: true,
			fanoutTxHash: true,
			reconciliationCompletedAt: true,
			_count: { select: { Transactions: { where: unsettledL2TransactionWhere } } },
		},
	});
	const live = heads.find((head) => head.status !== HydraHeadStatus.Final);
	if (live !== undefined) return { kind: 'live', status: live.status };
	if (heads.length === 0) return null;
	const unsettled = heads.some(
		(head) =>
			head.fanoutTxHash == null ||
			!FANOUT_TX_HASH_PATTERN.test(head.fanoutTxHash) ||
			head.reconciliationCompletedAt == null ||
			head._count.Transactions !== 0,
	);
	if (unsettled) return { kind: 'unsettled' };

	const headIds = heads.map(({ id }) => id);
	const [paymentHandoffs, purchaseHandoffs, hasUnsettledRequests] = await Promise.all([
		client.paymentRequest.count({ where: { hydraFanoutHandoffHeadId: { in: headIds } } }),
		client.purchaseRequest.count({ where: { hydraFanoutHandoffHeadId: { in: headIds } } }),
		hasUnsettledHydraRequestState(client, headIds),
	]);
	if (paymentHandoffs !== 0 || purchaseHandoffs !== 0 || hasUnsettledRequests) return { kind: 'handoffs' };
	return null;
}
