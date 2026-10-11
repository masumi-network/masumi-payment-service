/**
 * Read a head's state on L1 by hand, from an independent observer rather than
 * the head's own node: is it still open, closed (contestation running), or
 * fanned out? Read-only.
 */

import { adminAuthenticatedEndpointFactory } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import createHttpError, { isHttpError } from 'http-errors';
import { z } from '@masumi/payment-core/zod';
import { HydraHeadInitObservationError, observeHydraHeadIsOpenOnChain } from '@/lib/hydra/hydra/head-init-validation';
import { getBlockfrostInstance } from '@/utils/blockfrost';

export const checkHeadOnChainInput = z.object({
	id: z.string().min(1).describe('ID of the HydraHead to check'),
});

export const checkHeadOnChainOutput = z.object({
	chainState: z
		.enum(['open', 'closed', 'gone'])
		.describe('Head state after its newest state-token transaction; gone means fanned out'),
	latestTxHash: z.string().describe('Newest transaction that moved the head state token'),
});

export async function readHeadChainState(hydraHeadId: string) {
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

export const checkHeadOnChainPost = adminAuthenticatedEndpointFactory.build({
	method: 'post',
	input: checkHeadOnChainInput,
	output: checkHeadOnChainOutput,
	handler: async ({ input }) => {
		try {
			const { state, latestTxHash } = await readHeadChainState(input.id);
			return { chainState: state, latestTxHash };
		} catch (error) {
			if (isHttpError(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			if (error instanceof HydraHeadInitObservationError) throw createHttpError(503, message);
			throw createHttpError(502, `Could not read the head state on chain: ${message}`);
		}
	},
});
