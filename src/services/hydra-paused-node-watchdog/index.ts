/**
 * Wake a stopped node when its head is closed on chain.
 *
 * Disabling a head stops this side's node, so the counterparty stops locking
 * funds in a head nobody here observes. But a stopped node cannot contest. If
 * the counterparty closes with an old snapshot while the node is down, the head
 * settles on that snapshot once the contestation period ends. This reads the
 * head's state on L1 directly, without the node, and starts the node as soon
 * as the head is no longer Open, so it can contest in time.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { observeHydraHeadIsOpenOnChain } from '@/lib/hydra/hydra/head-init-validation';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { setOwnHeadNodeRunning, type OwnNodeRunStateOutcome } from '@/services/hydra-host/own-node-control';

export type DisabledHeadChainCheck = {
	isOpenOnChain: boolean;
	latestTxHash: string;
	/** Set when the head is no longer open and the node was asked to start. */
	nodeStart: OwnNodeRunStateOutcome | null;
};

export async function checkDisabledHeadOnChain(hydraHeadId: string): Promise<DisabledHeadChainCheck> {
	const head = await prisma.hydraHead.findUnique({
		where: { id: hydraHeadId },
		select: {
			headIdentifier: true,
			HydraRelation: {
				select: {
					network: true,
					LocalHotWallet: {
						select: { PaymentSource: { select: { PaymentSourceConfig: { select: { rpcProviderApiKey: true } } } } },
					},
				},
			},
		},
	});
	if (!head) throw new Error('Hydra head not found');
	if (!head.headIdentifier) throw new Error('Hydra head identifier has not been observed');
	const rpcProviderApiKey = head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
	if (!rpcProviderApiKey) throw new Error('Hydra head has no independent L1 observer configured');

	const observed = await observeHydraHeadIsOpenOnChain({
		observer: getBlockfrostInstance(head.HydraRelation.network, rpcProviderApiKey),
		headId: head.headIdentifier,
	});
	if (observed.isOpen) return { isOpenOnChain: true, latestTxHash: observed.latestTxHash, nodeStart: null };

	logger.error('[HydraPausedNodeWatchdog] head is no longer open on chain; starting its node so it can contest', {
		hydraHeadId,
		latestTxHash: observed.latestTxHash,
	});
	const nodeStart = await setOwnHeadNodeRunning(hydraHeadId, true, 'head is no longer open on L1; node must contest');
	return { isOpenOnChain: false, latestTxHash: observed.latestTxHash, nodeStart };
}

/**
 * One pass over disabled heads that may have a stopped node. Final heads have
 * nothing left to contest. Not capped: a head skipped here is a head that may
 * miss its contestation deadline, and disabled heads are few.
 */
export async function watchDisabledHeadsOnChain(): Promise<number> {
	const heads = await prisma.hydraHead.findMany({
		where: {
			isEnabled: false,
			headIdentifier: { not: null },
			status: { not: HydraHeadStatus.Final },
			LocalParticipant: { isNot: null },
		},
		select: { id: true },
	});
	let woken = 0;
	for (const head of heads) {
		try {
			const check = await checkDisabledHeadOnChain(head.id);
			if (!check.isOpenOnChain) woken += 1;
		} catch (error) {
			logger.warn('[HydraPausedNodeWatchdog] could not read the head state on chain', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return woken;
}
