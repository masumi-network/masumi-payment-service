/**
 * Comparing a live head's ledger against the chain it will settle on.
 *
 * The head's parameters come from the node itself, so this reads what the head
 * is really running rather than what a file on disk says — a node started with
 * an overridden `--ledger-protocol-parameters` would otherwise look fine while
 * being the one at risk. The chain side comes from the payment source's own
 * Blockfrost key, which is the same view the rest of the service settles
 * against.
 *
 * Cached, because this is polled by a readiness endpoint the admin UI refreshes
 * while an operator watches a head, and protocol parameters change at most once
 * in a few years. A stale reading here costs nothing; an extra chain query per
 * poll, on a rate-limited key shared with the node's own chain follower, costs
 * something real.
 */

import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { getHydraConnectionManager } from '@/services/hydra-connection-manager/hydra-connection-manager.service';
import { findParamDrift, type ParamDivergence } from '@/utils/hydra/params-drift';

/** Long, because the parameters this compares have moved once in four years. */
const DRIFT_CACHE_MS = 30 * 60 * 1000;

const cache = new Map<string, { at: number; drift: ParamDivergence[] }>();

/**
 * How the head's ledger differs from the chain, or an empty list.
 *
 * Never throws. This is decoration on a readiness answer, so a chain lookup
 * that fails must not take the readiness endpoint down with it — the operator
 * still needs to know whether the node is up.
 */
export async function readHeadParamDrift(hydraHeadId: string): Promise<ParamDivergence[]> {
	const cached = cache.get(hydraHeadId);
	if (cached && Date.now() - cached.at < DRIFT_CACHE_MS) return cached.drift;

	try {
		const provider = getHydraConnectionManager().getProvider(hydraHeadId);
		if (!provider) return [];

		const head = await prisma.hydraHead.findUnique({
			where: { id: hydraHeadId },
			select: {
				LocalParticipant: {
					select: { Wallet: { select: { PaymentSource: { select: { network: true, PaymentSourceConfig: true } } } } },
				},
			},
		});
		const source = head?.LocalParticipant?.Wallet?.PaymentSource;
		const apiKey = source?.PaymentSourceConfig?.rpcProviderApiKey;
		if (!source || !apiKey) return [];

		// The head's own view, asked of the head.
		const headParameters = await provider.fetchProtocolParameters();
		const blockfrost = getBlockfrostInstance(source.network, apiKey);
		const chainParameters = await blockfrost.epochsLatestParameters();

		const drift = findParamDrift(
			{
				utxoCostPerByte: Number(headParameters.coinsPerUtxoSize),
				maxValueSize: Number(headParameters.maxValSize),
			},
			{
				utxoCostPerByte: Number(chainParameters.coins_per_utxo_size),
				maxValueSize: Number(chainParameters.max_val_size),
			},
		);
		cache.set(hydraHeadId, { at: Date.now(), drift });
		return drift;
	} catch (error) {
		logger.warn(`[HydraParamDrift] could not compare head ${hydraHeadId} with the chain: ${String(error)}`);
		return [];
	}
}
