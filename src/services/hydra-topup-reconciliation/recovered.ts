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

import { SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot } from '@meshsdk/core';
import { HydraTopupStatus, Network as NetworkEnum } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { getBlockfrostInstance } from '@/utils/blockfrost';
import { lookupConfirmedChainTx } from '@/services/shared/chain-tx-lookup';
import { CONFIG } from '@masumi/payment-core/config';
import { mapWithConcurrency } from '@/utils/map-with-concurrency';
import { releaseHotWalletAfterL1 } from '@/utils/db/hot-wallet-lock';
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
 * How long past its TTL a Failed deposit is still checked.
 *
 * Failed means the deposit was not on chain past its TTL plus a short grace,
 * so it can never be recovered or absorbed. A deposit that never landed has
 * no transaction to read, and checking it forever only logs a lookup failure
 * on every tick. The window covers an L1 observer that lagged past the grace:
 * a deposit found on chain inside it goes back to Confirmed.
 */
export const FAILED_DEPOSIT_RECHECK_WINDOW_MS = 15 * 60 * 1000;

const MESH_NETWORK = { [NetworkEnum.Mainnet]: 'mainnet', [NetworkEnum.Preprod]: 'preprod' } as const;

/** Failed rows still inside the recheck window, one filter per network (slot numbers differ). */
function recentlyFailedFilters(nowMs: number) {
	return Object.values(NetworkEnum).map((network) => ({
		status: HydraTopupStatus.Failed,
		invalidHereafterSlot: {
			gte: BigInt(
				unixTimeToEnclosingSlot(nowMs - FAILED_DEPOSIT_RECHECK_WINDOW_MS, SLOT_CONFIG_NETWORK[MESH_NETWORK[network]]),
			),
		},
		LocalParticipant: { Wallet: { PaymentSource: { network } } },
	}));
}

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
	// being on chain first. Confirmed rows may still turn out recovered or
	// absorbed after the fact; Failed rows only within their recheck window.
	const [pending, settled] = await Promise.all([
		prisma.hydraTopup.findMany({
			where: { status: HydraTopupStatus.Pending, depositTxHash: { not: null } },
			include: candidateInclude,
			orderBy: { updatedAt: 'asc' },
			take: MAX_PENDING_CHECKS_PER_TICK,
		}),
		prisma.hydraTopup.findMany({
			where: {
				depositTxHash: { not: null },
				OR: [{ status: HydraTopupStatus.Confirmed }, ...recentlyFailedFilters(Date.now())],
			},
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
			if (candidate.status === HydraTopupStatus.Failed && outcome === 'unspent') {
				// The deposit is on chain after all: the observer lagged past the TTL
				// grace when the row was failed. Back to Confirmed, which is always
				// checked, so its later spend (fold-in or recovery) is still seen
				// after the Failed recheck window has passed. Only at the same depth
				// a normal promotion to Confirmed waits for: a shallower block can
				// still roll back, and past its TTL the deposit cannot land again.
				const depth = await lookupConfirmedChainTx({
					network: candidate.LocalParticipant.Wallet.PaymentSource.network,
					rpcProviderApiKey,
					txHash: candidate.depositTxHash,
					requiredConfirmations: CONFIG.BLOCK_CONFIRMATIONS_THRESHOLD,
				});
				if (depth === 'confirmed-valid') {
					const restored = await prisma.hydraTopup.updateMany({
						where: { id: candidate.id, status: HydraTopupStatus.Failed },
						data: { status: HydraTopupStatus.Confirmed },
					});
					if (restored.count === 1) {
						logger.warn(`hydra: deposit ${candidate.depositTxHash} was marked Failed but is on chain; now Confirmed`);
					}
					return;
				}
				// Not deep enough yet: rotated below like any other unresolved row.
			}
			if (outcome !== 'recovered' && outcome !== 'absorbed') {
				// Rotate the row to the back of the queue. Both reads are ordered by
				// `updatedAt` and take a fixed budget, so a row that never gets an
				// answer — a deposit whose script output is still sitting there, or a
				// lookup that keeps failing — is read again on every tick and nothing
				// behind it is ever reached. Failed rows are the ones that pile up
				// like this, and a full budget of them starves the Confirmed rows
				// whose absorption is what re-enables auto top-up.
				await prisma.hydraTopup
					.updateMany({ where: { id: candidate.id, status: candidate.status }, data: { updatedAt: new Date() } })
					.catch((error: unknown) =>
						logger.warn('hydra-topup-reconciliation: could not rotate an unresolved deposit check', {
							topupId: candidate.id,
							error: error instanceof Error ? error.message : error,
						}),
					);
				return;
			}

			const status = outcome === 'recovered' ? HydraTopupStatus.Recovered : HydraTopupStatus.Absorbed;
			const promoted = await prisma.hydraTopup.updateMany({
				where: { id: candidate.id, status: candidate.status },
				data: { status },
			});
			if (promoted.count === 1) {
				// A Pending row taken terminal here never reaches
				// `reconcilePendingHydraTopups`, which is the only other place that
				// hands the wallet back. Without this the deposit ends happily and the
				// wallet stays locked out of every L1 batcher until the safety net
				// clears it, which for a purpose-marked lock is half an hour.
				//
				// Excluding the commit handler's display row, which names the same L1
				// transaction as `LocalParticipant.commitTxHash`: the commit reconciler
				// owns that lock. The release is fenced on this row's own claim token.
				const isCommitDisplayRow = candidate.isInitialCommit;
				if (candidate.status === HydraTopupStatus.Pending && !isCommitDisplayRow) {
					await releaseHotWalletAfterL1(candidate.LocalParticipant.walletId, candidate.walletClaimToken);
				}
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
