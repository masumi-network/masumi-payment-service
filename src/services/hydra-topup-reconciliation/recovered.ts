/**
 * Notice when a recovered deposit has actually come home.
 *
 * Asking for a recovery and getting the funds back are different events, and
 * only the first was ever recorded. A deposit's status describes what the HEAD
 * did with it, and a recovered deposit is precisely one the head never took —
 * so it sat at "Submitted" forever while the money was already back in the
 * wallet. An operator had no way to tell posted-and-pending from home-and-safe,
 * and the honest answer to "did it work?" required reading the chain by hand.
 *
 * The evidence is simple and needs no node: the deposit's own output at the
 * deposit script is either still there or it is not. Gone means something spent
 * it, and after a recovery request the only thing that could is the recovery.
 */

import { HydraTopupStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import type { Network } from '@/generated/prisma/client';

/** Bounded so one tick cannot spend its whole budget on chain lookups. */
const MAX_RECOVERY_CHECKS_PER_TICK = 20;

/**
 * Whether every output of this deposit transaction has been spent.
 *
 * Blockfrost reports each output's consuming transaction, so this is a direct
 * read rather than an inference from a balance, which would be wrong the moment
 * the wallet is used for anything else.
 */
async function depositOutputsSpent(params: {
	network: Network;
	rpcProviderApiKey: string;
	depositTxHash: string;
}): Promise<boolean | null> {
	try {
		const blockfrost = getBlockfrostInstance(params.network, params.rpcProviderApiKey);
		const utxos = await blockfrost.txsUtxos(params.depositTxHash);
		const scriptOutputs = utxos.outputs.filter(
			(output) => output.address.startsWith('addr_test1w') || output.address.startsWith('addr1w'),
		);
		if (scriptOutputs.length === 0) return null;
		for (const output of scriptOutputs) {
			// `consumed_by_tx` is absent while the output is still unspent.
			const consumed = (output as { consumed_by_tx?: string | null }).consumed_by_tx;
			if (consumed == null) return false;
		}
		return true;
	} catch (error) {
		// A lookup failure is not evidence of anything; leave the row alone and
		// let the next tick decide.
		logger.warn('hydra-topup-reconciliation: could not check whether a recovered deposit was spent', {
			depositTxHash: params.depositTxHash,
			error: error instanceof Error ? error.message : error,
		});
		return null;
	}
}

/**
 * Promote deposits whose recovery has landed.
 *
 * Only rows that asked for a recovery are considered: an unspent deposit that
 * nobody recovered is simply waiting, and one the head absorbed is not at the
 * script to begin with.
 */
export async function reconcileRecoveredHydraTopups(): Promise<void> {
	const candidates = await prisma.hydraTopup.findMany({
		where: {
			recoveryRequestedAt: { not: null },
			status: { in: [HydraTopupStatus.Confirmed, HydraTopupStatus.Failed] },
			depositTxHash: { not: null },
		},
		include: {
			LocalParticipant: {
				include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
			},
		},
		orderBy: { updatedAt: 'asc' },
		take: MAX_RECOVERY_CHECKS_PER_TICK,
	});

	await Promise.allSettled(
		candidates.map(async (candidate) => {
			const rpcProviderApiKey = candidate.LocalParticipant.Wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (rpcProviderApiKey == null || candidate.depositTxHash == null) return;

			const spent = await depositOutputsSpent({
				network: candidate.LocalParticipant.Wallet.PaymentSource.network,
				rpcProviderApiKey,
				depositTxHash: candidate.depositTxHash,
			});
			if (spent !== true) return;

			const promoted = await prisma.hydraTopup.updateMany({
				where: { id: candidate.id, recoveryRequestedAt: { not: null }, status: candidate.status },
				data: { status: HydraTopupStatus.Recovered },
			});
			if (promoted.count === 1) {
				logger.info(`hydra: deposit ${candidate.depositTxHash} was recovered; the funds are back in the wallet`);
			}
		}),
	);
}
