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

/**
 * A script address, which the `w` prefix marks on Cardano.
 *
 * Used to tell a recovery from a fold-in: only a fold-in pays the head's state
 * output back to a script.
 */
function isScriptAddress(address: string): boolean {
	return address.startsWith('addr_test1w') || address.startsWith('addr1w');
}

/** Bounded so one tick cannot spend its whole budget on chain lookups. */
const MAX_RECOVERY_CHECKS_PER_TICK = 20;

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
	const candidates = await prisma.hydraTopup.findMany({
		where: {
			// Every confirmed deposit, not only ones a recovery was asked for: a
			// deposit the head takes in needs saying so just as much, and that is
			// the case that left Recover on offer for funds already on L2.
			//
			// Pending is included for the same reason one step earlier. Promotion to
			// Confirmed waits on BLOCK_CONFIRMATIONS_THRESHOLD, but the head folds a
			// deposit in on its own schedule — so a row could sit at Pending, and
			// read as "not arrived", while the funds were already spendable on L2.
			// Finding the deposit's own output already spent is stronger evidence
			// than a confirmation count: it cannot have been spent without being on
			// chain first.
			status: { in: [HydraTopupStatus.Pending, HydraTopupStatus.Confirmed, HydraTopupStatus.Failed] },
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
		}),
	);
}
