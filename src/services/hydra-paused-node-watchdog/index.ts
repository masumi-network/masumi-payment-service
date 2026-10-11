/**
 * Keep a disabled head's node in the state the chain calls for.
 *
 * A disabled head is invisible to this side, but a running node keeps
 * co-signing, so the counterparty keeps locking funds in it. Its node must be
 * stopped. A stopped node cannot contest, though: if the counterparty closes
 * with an old snapshot, the head settles on it once the contestation period
 * ends. So the head's state is read on L1, without the node:
 *   open   → stop the node (the counterparty then sees a disconnected peer)
 *   closed → start it, so it can contest
 *   gone   → fanned out; nothing to do
 * Every pause goes through here, so a stop is never sent for a head that is
 * already closed on chain.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import createHttpError from 'http-errors';
import { HydraHeadStatus } from '@/generated/prisma/client';
import { observeHydraHeadIsOpenOnChain, type HydraHeadChainState } from '@/lib/hydra/hydra/head-init-validation';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { setOwnHeadNodeRunning, type OwnNodeRunStateOutcome } from '@/services/hydra-host/own-node-control';

/** How often disabled heads are checked. Mainnet contestation periods are hours; preprod's is minutes. */
export const HYDRA_DISABLED_HEAD_WATCH_INTERVAL_MS = 60_000;

export type DisabledHeadNodeCheck = {
	chainState: HydraHeadChainState;
	latestTxHash: string;
	/** What was asked of the node; null when nothing was (head enabled again, or gone). */
	nodeAction: 'stop' | 'start' | null;
	nodeOutcome: OwnNodeRunStateOutcome | null;
};

async function readHeadChainState(hydraHeadId: string) {
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
	if (!head) throw createHttpError(404, 'Hydra head not found');
	if (!head.headIdentifier) throw createHttpError(409, 'Hydra head identifier has not been observed');
	const rpcProviderApiKey = head.HydraRelation.LocalHotWallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
	if (!rpcProviderApiKey) throw createHttpError(409, 'Hydra head has no independent L1 observer configured');
	return await observeHydraHeadIsOpenOnChain({
		observer: getBlockfrostInstance(head.HydraRelation.network, rpcProviderApiKey),
		headId: head.headIdentifier,
	});
}

/** Read the head on L1 and stop or start its node to match. Throws when the chain cannot be read. */
export async function convergeDisabledHeadNode(hydraHeadId: string, reason: string): Promise<DisabledHeadNodeCheck> {
	const { state: chainState, latestTxHash } = await readHeadChainState(hydraHeadId);
	if (chainState === 'gone') return { chainState, latestTxHash, nodeAction: null, nodeOutcome: null };
	if (chainState === 'closed') {
		logger.error('[HydraDisabledHeadNode] head is closed on chain; starting its node so it can contest', {
			hydraHeadId,
			latestTxHash,
		});
		const nodeOutcome = await setOwnHeadNodeRunning(hydraHeadId, true, 'head is closed on L1; node must contest');
		return { chainState, latestTxHash, nodeAction: 'start', nodeOutcome };
	}
	// Read again after the chain lookup: an operator re-enable may have landed
	// meanwhile, and its node must keep running.
	const head = await prisma.hydraHead.findUnique({ where: { id: hydraHeadId }, select: { isEnabled: true } });
	if (head?.isEnabled !== false) return { chainState, latestTxHash, nodeAction: null, nodeOutcome: null };
	const nodeOutcome = await setOwnHeadNodeRunning(hydraHeadId, false, reason);
	if (nodeOutcome !== 'requested' && nodeOutcome !== 'head-closing') {
		logger.error(
			'[HydraDisabledHeadNode] could not stop the node of a disabled head; the counterparty may still use it',
			{
				hydraHeadId,
				nodeOutcome,
			},
		);
	}
	return { chainState, latestTxHash, nodeAction: 'stop', nodeOutcome };
}

/**
 * One pass over disabled heads that are not final. Not capped: a head skipped
 * here may miss its contestation deadline, and disabled heads are few.
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
	let started = 0;
	for (const head of heads) {
		try {
			const check = await convergeDisabledHeadNode(head.id, 'head is disabled and open on L1');
			if (check.nodeAction === 'start') started += 1;
		} catch (error) {
			logger.warn('[HydraDisabledHeadNode] could not read the head state on chain', {
				hydraHeadId: head.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	return started;
}
