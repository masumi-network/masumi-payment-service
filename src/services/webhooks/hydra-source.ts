import { WebhookEventType } from '@/generated/prisma/client';
import type { Prisma } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';

const SOURCE_SCOPED_HYDRA_EVENTS = new Set<WebhookEventType>([
	WebhookEventType.HYDRA_HEAD_LOW_BALANCE,
	WebhookEventType.HYDRA_HEAD_SNAPSHOT_ROUND_STUCK,
	WebhookEventType.HYDRA_HEAD_POST_TX_FAILED,
	WebhookEventType.HYDRA_HEAD_CONTEST_MISSING,
	WebhookEventType.HYDRA_HEAD_CONTEST_WATCH_ALERT,
]);

export function isSourceScopedHydraEvent(eventType: WebhookEventType): boolean {
	return SOURCE_SCOPED_HYDRA_EVENTS.has(eventType);
}

type HydraWebhookQueryClient = Pick<Prisma.TransactionClient, 'hydraHead'>;

/** Resolve an event's owner from durable head and funding-wallet bindings. */
export async function findHydraHeadPaymentSourceId(
	hydraHeadId: string,
	client: HydraWebhookQueryClient = prisma,
	hydraLocalParticipantId?: string,
): Promise<string | null> {
	const head = await client.hydraHead.findUnique({
		where: { id: hydraHeadId },
		select: {
			HydraRelation: { select: { localHotWalletId: true, LocalHotWallet: { select: { paymentSourceId: true } } } },
			LocalParticipant: { select: { id: true, walletId: true } },
		},
	});
	if (
		!head?.HydraRelation.LocalHotWallet.paymentSourceId ||
		!head.LocalParticipant ||
		head.LocalParticipant.walletId !== head.HydraRelation.localHotWalletId ||
		(hydraLocalParticipantId && head.LocalParticipant.id !== hydraLocalParticipantId)
	) {
		return null;
	}
	return head.HydraRelation.LocalHotWallet.paymentSourceId;
}
