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
 * The exact deposit input's spending redeemer distinguishes Claim from Recover.
 * Other outputs say nothing about it: a recovery can carry script change.
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
import { classifyHydraDepositSpend, findHydraDepositReference } from './deposit-evidence';

/**
 * How many rows of each kind one tick examines.
 *
 * Split into separate budgets rather than one shared take because the classes must
 * not starve each other. Pending is the larger and oldest-first pool, and under
 * a single `orderBy updatedAt asc` take it could fill the whole tick before a
 * Confirmed row waiting to be marked Absorbed was reached. Historical terminal
 * labels have their own budget so old heuristic mistakes are corrected too.
 */
const MAX_PENDING_CHECKS_PER_TICK = 20;
const MAX_SETTLED_CHECKS_PER_TICK = 20;
const MAX_TERMINAL_CHECKS_PER_TICK = 20;

/**
 * How many chain lookups run at once, across both budgets.
 *
 * Each candidate reads the deposit body, its indexed outputs and its consumer
 * body, and the candidates used to be started all together — up to a full
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

/** What L1 did with a deposit, decided from the transaction that spent it. */
type DepositOutcome = 'unspent' | 'recovered' | 'absorbed' | 'unknown';

async function depositOutcome(params: {
	network: Network;
	rpcProviderApiKey: string;
	depositTxHash: string;
	headIdentifier: string | null;
}): Promise<DepositOutcome> {
	try {
		if (params.headIdentifier === null) return 'unknown';
		const blockfrost = getBlockfrostInstance(params.network, params.rpcProviderApiKey);
		const depositCbor = await blockfrost.txsCbor(params.depositTxHash);
		const deposit = findHydraDepositReference({
			cborHex: depositCbor.cbor,
			txHash: params.depositTxHash,
			headIdentifier: params.headIdentifier,
			networkId: params.network === NetworkEnum.Mainnet ? 1 : 0,
		});
		if (deposit === null) return 'unknown';
		const utxos = await blockfrost.txsUtxos(params.depositTxHash);
		const output = utxos.outputs.find((candidate) => candidate.output_index === deposit.outputIndex);
		if (!output || output.address !== deposit.address) return 'unknown';
		const consumed = (output as { consumed_by_tx?: string | null }).consumed_by_tx;
		if (consumed == null) return 'unspent';
		const spendingCbor = await blockfrost.txsCbor(consumed);
		return classifyHydraDepositSpend({ cborHex: spendingCbor.cbor, txHash: consumed, deposit }) ?? 'unknown';
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
 * trace: the deposit's own output is spent. Its exact input redeemer tells
 * them apart, after both transaction bodies have been bound to their hashes.
 *
 * Rows are considered from Pending onward rather than from Confirmed, because
 * the head does not wait for our confirmation threshold before absorbing.
 */
export async function reconcileRecoveredHydraTopups(): Promise<void> {
	const candidateInclude = {
		HydraHead: { select: { headIdentifier: true } },
		LocalParticipant: {
			include: { Wallet: { include: { PaymentSource: { include: { PaymentSourceConfig: true } } } } },
		},
	} as const;

	// Separate queries and budgets, so a Pending backlog cannot crowd out the
	// Confirmed and Failed rows. Pending is separated because it is the case that
	// reads "not arrived" while the head has already folded the deposit in.
	// Confirmed and terminal rows remain observable; Failed rows are checked only
	// within their recheck window.
	const [pending, terminal, settled] = await Promise.all([
		prisma.hydraTopup.findMany({
			where: { status: HydraTopupStatus.Pending, depositTxHash: { not: null } },
			include: candidateInclude,
			orderBy: { updatedAt: 'asc' },
			take: MAX_PENDING_CHECKS_PER_TICK,
		}),
		prisma.hydraTopup.findMany({
			where: {
				depositTxHash: { not: null },
				status: { in: [HydraTopupStatus.Absorbed, HydraTopupStatus.Recovered] },
			},
			include: candidateInclude,
			orderBy: { updatedAt: 'asc' },
			take: MAX_TERMINAL_CHECKS_PER_TICK,
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

	// Bounded across all budgets, so the concurrent Blockfrost burst is capped.
	await mapWithConcurrency(
		[...pending, ...settled, ...terminal],
		RECOVERY_LOOKUP_CONCURRENCY,
		async (candidate) => {
			const rpcProviderApiKey = candidate.LocalParticipant.Wallet.PaymentSource.PaymentSourceConfig?.rpcProviderApiKey;
			if (rpcProviderApiKey == null || candidate.depositTxHash == null) return;

			const outcome = await depositOutcome({
				network: candidate.LocalParticipant.Wallet.PaymentSource.network,
				rpcProviderApiKey,
				depositTxHash: candidate.depositTxHash,
				headIdentifier: candidate.HydraHead.headIdentifier,
			});
			if (
				outcome === 'unspent' &&
				(candidate.status === HydraTopupStatus.Failed ||
					candidate.status === HydraTopupStatus.Absorbed ||
					candidate.status === HydraTopupStatus.Recovered)
			) {
				// The deposit is unspent after all. Back to Confirmed, which is always
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
						where: { id: candidate.id, status: candidate.status },
						data: { status: HydraTopupStatus.Confirmed },
					});
					if (restored.count === 1) {
						logger.warn(
							`hydra: deposit ${candidate.depositTxHash} was marked ${candidate.status} but is unspent on chain; now Confirmed`,
						);
					}
					return;
				}
				// Not deep enough yet: rotated below like any other unresolved row.
			}
			if (outcome !== 'recovered' && outcome !== 'absorbed') {
				// Rotate the row to the back of the queue. All reads are ordered by
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
