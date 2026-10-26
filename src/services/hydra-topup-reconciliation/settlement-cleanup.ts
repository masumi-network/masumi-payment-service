import createHttpError from 'http-errors';
import { HydraTopupStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { CONFIG } from '@masumi/payment-core/config';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { observeHydraDepositSettlement } from './settlement-evidence';

/** Recheck chain evidence before destroying the signer or its recovery records. */
export async function assertHydraDepositSettlementsFinal(headIds: readonly string[]): Promise<void> {
	const candidates = await prisma.hydraTopup.findMany({
		where: {
			hydraHeadId: { in: [...headIds] },
			status: { in: [HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered] },
		},
		include: {
			HydraHead: { select: { headIdentifier: true } },
			LocalParticipant: {
				include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
			},
		},
	});
	for (const candidate of candidates) {
		const rpcProviderApiKey = candidate.LocalParticipant.Wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
		if (candidate.settlementTxHash == null || candidate.depositTxHash == null || !rpcProviderApiKey) {
			throw createHttpError(409, 'Cannot delete: Hydra deposit settlement has no independently validated proof');
		}
		const network = candidate.LocalParticipant.Wallet.PaymentSource.network;
		const evidence = await observeHydraDepositSettlement({
			network,
			rpcProviderApiKey,
			depositTxHash: candidate.depositTxHash,
			headIdentifier: candidate.HydraHead.headIdentifier,
		});
		const expectedOutcome = candidate.status === HydraTopupStatus.Absorbed ? 'absorbed' : 'recovered';
		if (
			(evidence.outcome === 'absorbed' || evidence.outcome === 'recovered') &&
			evidence.outcome === expectedOutcome &&
			evidence.settlementTxHash === candidate.settlementTxHash
		) {
			continue;
		}
		// Unknown evidence revokes permission to destroy keys. Only a confirmed,
		// unspent original deposit can reopen the terminal label itself.
		const isConfirmedUnspent =
			evidence.outcome === 'unspent' &&
			(await lookupConfirmedChainTx({
				network,
				rpcProviderApiKey,
				txHash: candidate.depositTxHash,
				requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
			})) === 'confirmed-valid';
		await prisma.hydraTopup.updateMany({
			where: {
				id: candidate.id,
				status: candidate.status,
				depositTxHash: candidate.depositTxHash,
				settlementTxHash: candidate.settlementTxHash,
			},
			data: {
				settlementTxHash: null,
				...(isConfirmedUnspent ? { status: HydraTopupStatus.Confirmed } : {}),
			},
		});
		throw createHttpError(
			409,
			'Cannot delete: Hydra deposit settlement is not independently final on the current chain',
		);
	}
}
