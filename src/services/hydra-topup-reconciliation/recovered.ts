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
import { mapWithConcurrency } from '@/utils/map-with-concurrency';
import type { Network } from '@/generated/prisma/client';

/**
 * A script address, which the `w` prefix marks on Cardano.
 *
 * Used to tell a recovery from a fold-in: only a fold-in pays the head's state
 * output back to a script.
 */
function isScriptAddress(address: string): boolean {
	return address.startsWith('addr_test1w') || address.startsWith('addr1w');
}

/**
 * How many rows of each kind one tick examines.
 *
 * Split into two budgets rather than one shared take because the classes must
 * not starve each other. Pending is the larger and oldest-first pool, and under
 * a single `orderBy updatedAt asc` take it could fill the whole tick before a
 * Confirmed row waiting to be marked Absorbed was reached. A budget apiece
 * guarantees both are looked at every tick.
 */
const MAX_PENDING_CHECKS_PER_TICK = 20;
const MAX_SETTLED_CHECKS_PER_TICK = 20;

/**
 * How many chain lookups run at once, across both budgets.
 *
 * Each candidate costs one Blockfrost read for the deposit plus one per
 * consumer, and the candidates used to be started all together — up to a full
 * tick's worth of concurrent requests every CHECK_HYDRA_TX_INTERVAL, which on a
 * metered plan trips rate limits. This bounds the burst without shrinking how
 * much a tick gets through, since the work is I/O-bound.
 */
const RECOVERY_LOOKUP_CONCURRENCY = 6;

/**
 * Whether every output of this deposit transaction has been spent.
 *
 * Blockfrost reports each output's consuming transaction, so this is a direct
 * read rather than an inference from a balance, which would be wrong the moment
 * the wallet is used for anything else.
 */
/** What L1 did with a deposit, decided from the transaction that spent it. */
type DepositOutcome = 'unspent' | 'recovered' | 'absorbed' | 'unknown';

async function depositOutcome(params: {
	network: Network;
	rpcProviderApiKey: string;
	depositTxHash: string;
}): Promise<DepositOutcome> {
	try {
		const blockfrost = getBlockfrostInstance(params.network, params.rpcProviderApiKey);
		const utxos = await blockfrost.txsUtxos(params.depositTxHash);
		const scriptOutputs = utxos.outputs.filter((output) => isScriptAddress(output.address));
		if (scriptOutputs.length === 0) return 'unknown';
		const consumers = new Set<string>();
		for (const output of scriptOutputs) {
			// `consumed_by_tx` is absent while the output is still unspent.
			const consumed = (output as { consumed_by_tx?: string | null }).consumed_by_tx;
			if (consumed == null) return 'unspent';
			consumers.add(consumed);
		}

		// Spent is not the same as recovered. The head absorbing a deposit spends it
		// too, and the two outcomes are opposites: one puts the funds back in the
		// wallet, the other puts them on L2.
		//
		// What tells them apart is what the spending transaction produces: a
		// fold-in carries the head forward, so it pays the head's state output to a
		// script address. A recovery pays only to wallets.
		for (const consumer of consumers) {
			const spend = await blockfrost.txsUtxos(consumer);
			if (spend.outputs.some((output) => isScriptAddress(output.address))) return 'absorbed';
		}
		return 'recovered';
	} catch (error) {
		// A lookup failure is not evidence of anything; leave the row alone and
		// let the next tick decide.
		logger.warn('hydra-topup-reconciliation: could not check whether a recovered deposit was spent', {
			depositTxHash: params.depositTxHash,
			error: error instanceof Error ? error.message : error,
		});
		return 'unknown';
	}
}

/**
 * Say what L1 did with every deposit that is still waiting on an answer.
 *
 * Not only rows that asked for a recovery. A deposit has two ways to stop
 * waiting — the head folds it in, or it comes home — and both leave the same
 * trace: the deposit's own output is spent. What the spending transaction pays
 * to tells them apart.
 *
 * Rows are considered from Pending onward rather than from Confirmed, because
 * the head does not wait for our confirmation threshold before absorbing.
 */
export async function reconcileRecoveredHydraTopups(): Promise<void> {
	const candidateInclude = {
		LocalParticipant: {
			include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
		},
	} as const;

	// Two queries, one budget each, so a Pending backlog cannot crowd out the
	// Confirmed and Failed rows. Pending is separated because it is the case that
	// reads "not arrived" while the head has already folded the deposit in:
	// promotion to Confirmed waits on BLOCK_CONFIRMATIONS_THRESHOLD, but the head
	// absorbs on its own schedule, and the deposit's own output being spent is
	// stronger evidence than a confirmation count — it cannot be spent without
	// being on chain first. Confirmed and Failed are the rows that may still turn
	// out recovered or absorbed after the fact.
	const [pending, settled] = await Promise.all([
		prisma.hydraTopup.findMany({
			where: { status: HydraTopupStatus.Pending, depositTxHash: { not: null } },
			include: candidateInclude,
			orderBy: { updatedAt: 'asc' },
			take: MAX_PENDING_CHECKS_PER_TICK,
		}),
		prisma.hydraTopup.findMany({
			where: { status: { in: [HydraTopupStatus.Confirmed, HydraTopupStatus.Failed] }, depositTxHash: { not: null } },
			include: candidateInclude,
			orderBy: { updatedAt: 'asc' },
			take: MAX_SETTLED_CHECKS_PER_TICK,
		}),
	]);

	// Bounded across both budgets, so the concurrent Blockfrost burst is capped
	// however many rows the two queries returned.
	await mapWithConcurrency(
		[...pending, ...settled],
		RECOVERY_LOOKUP_CONCURRENCY,
		async (candidate) => {
			const rpcProviderApiKey = candidate.LocalParticipant.Wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (rpcProviderApiKey == null || candidate.depositTxHash == null) return;

			const outcome = await depositOutcome({
				network: candidate.LocalParticipant.Wallet.PaymentSource.network,
				rpcProviderApiKey,
				depositTxHash: candidate.depositTxHash,
			});
			if (outcome !== 'recovered' && outcome !== 'absorbed') return;

			const status = outcome === 'recovered' ? HydraTopupStatus.Recovered : HydraTopupStatus.Absorbed;
			const promoted = await prisma.hydraTopup.updateMany({
				where: { id: candidate.id, status: candidate.status },
				data: { status },
			});
			if (promoted.count === 1) {
				logger.info(
					outcome === 'recovered'
						? `hydra: deposit ${candidate.depositTxHash} was recovered; the funds are back in the wallet`
						: `hydra: deposit ${candidate.depositTxHash} was taken into the head`,
				);
			}
		},
		(error, candidate) =>
			logger.warn('hydra-topup-reconciliation: a recovered-deposit check failed', {
				topupId: candidate.id,
				error: error instanceof Error ? error.message : error,
			}),
	);
}
