import type { BlockfrostProvider, MeshWallet } from '@/services/shared';
import { Transaction as MeshTransaction } from '@/services/shared';
import { TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import type { UTxO } from '@meshsdk/core';

/**
 * Required wallet shape for collateral readiness:
 *   - one pure-ADA UTxO of ≥ COLLATERAL_RESERVE_LOVELACE for collateral input
 *   - AT LEAST ONE additional UTxO so the fee input does not OVERLAP the
 *     collateral input.
 *
 * Cardano's ledger rules disallow the same input appearing in both
 * `inputs` and `collateral_inputs` of a script-spending transaction:
 * once a buyer wallet drains down to a single UTxO, any subsequent
 * script-spending action (request-refund, collect-refund, submit-result,
 * etc.) cannot build a valid tx until a second UTxO appears in the
 * wallet. This module owns the "before each script tx, top up the
 * wallet's UTxO count" responsibility.
 */
export const COLLATERAL_RESERVE_LOVELACE = 5_000_000n;
/**
 * Minimum total wallet lovelace required to build a prep tx. The prep tx
 * sends 5 ADA back to self (the collateral reserve), expects mesh to emit
 * a change output (≥ ~1.5 ADA min UTxO at current params), and budgets ~0.5 ADA
 * of fee. 7 ADA covers all three with a comfortable safety margin.
 */
export const PREP_TX_MIN_LOVELACE = 7_000_000n;

export type EnsureCollateralReadyResult =
	| { status: 'ready' }
	| { status: 'deferred'; prepTxHash: string }
	| { status: 'failed'; reason: 'insufficient_funds' | 'prep_tx_failed'; details: string };

export type EnsureCollateralReadyParams = {
	walletDbId: string;
	walletAddress: string;
	meshWallet: MeshWallet;
	utxos: UTxO[];
	blockchainProvider: BlockfrostProvider;
	/** Short label for log lines so a single grep can attribute prep calls to
	 *  the service that triggered them (e.g. 'request-refund'). */
	serviceLabel: string;
};

export type WalletStateClassification = {
	hasGoodCollateral: boolean;
	utxoCount: number;
	totalLovelace: bigint;
	ready: boolean;
	fundedForPrep: boolean;
};

/**
 * Pure classification of a wallet's UTxO set against the collateral
 * readiness invariant. Extracted as a free function so the decision logic
 * is unit-testable without mocking mesh's Transaction class.
 *
 *   - `hasGoodCollateral` — at least one UTxO is pure-ADA (only `lovelace`
 *     asset) AND has ≥ COLLATERAL_RESERVE_LOVELACE. Tokens-on-the-same-UTxO
 *     disqualify it for collateral use: Cardano requires collateral to be
 *     a single, simple pay-to-pubkey-hash output and many ledger
 *     implementations further restrict it to lovelace-only.
 *   - `utxoCount` — total UTxOs in the wallet (the second UTxO requirement
 *     is the whole reason this module exists; see the module-level note).
 *   - `totalLovelace` — sum of `lovelace` across every UTxO, used to gate
 *     the prep-tx build (insufficient funds bail-out).
 *   - `ready` — composite gate: `hasGoodCollateral && utxoCount >= 2`.
 *   - `fundedForPrep` — `totalLovelace >= PREP_TX_MIN_LOVELACE`. Even when
 *     `ready` is false, the wallet might be so underfunded that we cannot
 *     even build the self-send prep tx — in that case the caller surfaces
 *     a hard failure rather than queueing a doomed submit.
 */
export function classifyWalletState(utxos: UTxO[]): WalletStateClassification {
	let totalLovelace = 0n;
	let hasGoodCollateral = false;

	for (const utxo of utxos) {
		const amounts = utxo.output.amount;
		let lovelaceForThisUtxo = 0n;
		let isPureAda = true;
		for (const asset of amounts) {
			if (asset.unit === 'lovelace' || asset.unit === '') {
				lovelaceForThisUtxo += BigInt(asset.quantity);
			} else {
				isPureAda = false;
			}
		}
		totalLovelace += lovelaceForThisUtxo;
		if (isPureAda && lovelaceForThisUtxo >= COLLATERAL_RESERVE_LOVELACE) {
			hasGoodCollateral = true;
		}
	}

	const utxoCount = utxos.length;
	const ready = hasGoodCollateral && utxoCount >= 2;
	const fundedForPrep = totalLovelace >= PREP_TX_MIN_LOVELACE;

	return { hasGoodCollateral, utxoCount, totalLovelace, ready, fundedForPrep };
}

/**
 * Before each V2 script-spending action: confirm the wallet has both a
 * pure-ADA collateral UTxO and at least one additional UTxO to feed the
 * fee input.
 *
 * Outcomes:
 *   - 'ready'           — wallet meets the invariant; caller proceeds.
 *   - 'deferred'        — wallet had enough funds but only one UTxO (or
 *                         no good collateral). We submitted a self-send
 *                         prep tx; caller MUST return without consuming
 *                         the lock. wallet-timeouts (or tx-sync once it
 *                         observes the prep txHash) will clear the lock
 *                         once the prep tx confirms.
 *   - 'failed'          — either the wallet is too underfunded to even
 *                         build a prep tx, or the prep tx itself failed
 *                         to submit. Caller treats this as a transient
 *                         operational error: leave items queued and let
 *                         the next tick re-evaluate.
 *
 * The prep tx is wired into the same DB-locking pattern as a real script
 * action: a shared Transaction row carrying BlocksWallet → wallet. That
 * row keeps the hot wallet locked until tx-sync (or wallet-timeouts)
 * observes confirmation and unlocks it. The wallet stays unavailable to
 * other batchers in the meantime, which is intentional — we do not want
 * a concurrent batch to spend the just-issued prep UTxOs before they
 * settle.
 */
export async function ensureCollateralReady(params: EnsureCollateralReadyParams): Promise<EnsureCollateralReadyResult> {
	const { walletDbId, walletAddress, meshWallet, utxos, serviceLabel } = params;
	const classification = classifyWalletState(utxos);

	if (classification.ready) {
		return { status: 'ready' };
	}

	if (!classification.fundedForPrep) {
		// WARN, not ERROR: every scheduler tick that picks this wallet up
		// re-runs the helper, so an underfunded wallet would otherwise spam
		// an identical ERROR row every ~30-60 s until operator funds it. No
		// per-wallet `lastErroredAt` column exists today; if log volume ever
		// becomes a problem the right next step is adding one and rate-
		// limiting the WARN to once per hour. CI annotator
		// (`[collateral-prep]` marker) still surfaces every occurrence in
		// the GitHub workflow run summary.
		logger.warn('V2 wallet underfunded for collateral prep [collateral-prep]', {
			walletDbId,
			walletAddress,
			serviceLabel,
			utxoCount: classification.utxoCount,
			totalLovelace: classification.totalLovelace.toString(),
			minRequiredLovelace: PREP_TX_MIN_LOVELACE.toString(),
			note: 'underfunded — operator must fund wallet; this log repeats every scheduler tick until resolved',
		});
		// The outer caller's `lockAndQueryX` set `lockedAt = now` on this wallet.
		// We did NOT submit a prep tx (no PendingTransaction was connected), so
		// `wallet-timeouts` will never pick this wallet up via its query filter
		// (`PendingTransaction != null` is required). Without an explicit unlock,
		// the wallet would sit at lockedAt-set/pendingTransactionId-null forever.
		// Clear lockedAt so the next scheduler tick (after the operator funds
		// the wallet) can re-pick it up.
		await unlockWalletLock(walletDbId, serviceLabel);
		return {
			status: 'failed',
			reason: 'insufficient_funds',
			details: `wallet has ${classification.totalLovelace.toString()} lovelace across ${classification.utxoCount} UTxO(s); need at least ${PREP_TX_MIN_LOVELACE.toString()} to build collateral prep tx`,
		};
	}

	// Build the prep tx. Send the collateral reserve explicitly back to
	// the wallet's own address; mesh will then add a change output for
	// the remainder, naturally producing the second UTxO we need to
	// avoid the inputs/collateral_inputs overlap on the next script tx.
	const meshTx = new MeshTransaction({
		initiator: meshWallet,
		fetcher: params.blockchainProvider,
	}).setMetadata(674, {
		msg: ['Masumi', 'CollateralPrep'],
	});

	meshTx.sendAssets({ address: walletAddress }, [
		{ unit: 'lovelace', quantity: COLLATERAL_RESERVE_LOVELACE.toString() },
	]);

	let sharedTxId: string;
	try {
		sharedTxId = await retryOnSerializationConflict(
			() =>
				prisma.$transaction(
					async (tx) => {
						const sharedTx = await tx.transaction.create({
							data: {
								status: TransactionStatus.Pending,
								// `lastCheckedAt: now` is REQUIRED to keep this row visible
								// to the `wallet-timeouts` cron. Its query filters on
								// `PendingTransaction.lastCheckedAt: { lte: now - 1min }`
								// and Prisma's `lte` does NOT match NULL — without a
								// concrete timestamp the row is never polled, so the wallet
								// that points at it (via the BlocksWallet connect below)
								// stays locked forever and the action that requested the
								// prep tx never resumes. Setting `now` debounces the first
								// poll by 1 minute, comfortably longer than the
								// build/sign/submit window (~10-20s in practice).
								lastCheckedAt: new Date(),
								BlocksWallet: { connect: { id: walletDbId } },
							},
						});
						return sharedTx.id;
					},
					{ timeout: 30_000 },
				),
			{ label: 'collateral-prep-presubmit' },
		);
	} catch (dbError) {
		logger.error('V2 collateral prep DB pre-submit failed [collateral-prep]', {
			walletDbId,
			walletAddress,
			serviceLabel,
			error:
				dbError instanceof Error ? { message: dbError.message, name: dbError.name, stack: dbError.stack } : dbError,
		});
		// No PendingTransaction was successfully connected, so the wallet's
		// `lockedAt` (set by the outer `lockAndQueryX`) won't be cleared by
		// `wallet-timeouts`. Unlock explicitly so the next tick can retry.
		await unlockWalletLock(walletDbId, serviceLabel);
		return {
			status: 'failed',
			reason: 'prep_tx_failed',
			details: dbError instanceof Error ? dbError.message : String(dbError),
		};
	}

	let unsignedTx: string;
	let signedTx: string;
	let prepTxHash: string;
	try {
		unsignedTx = await meshTx.build();
		signedTx = await meshWallet.signTx(unsignedTx);
		prepTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		// Rollback the shared Tx row's wallet lock AND mark the row as
		// RolledBack. The wallet update releases `pendingTransactionId` so
		// the next scheduler tick can re-pick the wallet up; the Tx update
		// flips status away from `Pending` so the row stops looking like an
		// in-flight tx during triage (it has no `txHash` and no back-edges
		// from any request, so without an explicit status change it would
		// sit as `Pending` forever — invisible to wallet-timeouts after
		// disconnect and invisible to tx-sync without a CurrentTransaction
		// edge). Both writes share one $transaction so the wallet is never
		// observed half-disconnected. Retry on serialization conflict in
		// case a concurrent writer holds either row.
		try {
			await retryOnSerializationConflict(
				() =>
					prisma.$transaction(async (tx) => {
						await tx.hotWallet.update({
							where: { id: walletDbId, deletedAt: null },
							data: {
								PendingTransaction: { disconnect: true },
								lockedAt: null,
							},
						});
						await tx.transaction.update({
							where: { id: sharedTxId },
							data: { status: TransactionStatus.RolledBack },
						});
					}),
				{ label: 'collateral-prep-rollback-unlock' },
			);
		} catch (rollbackError) {
			logger.warn('V2 collateral prep rollback failed (non-fatal) [collateral-prep]', {
				walletDbId,
				serviceLabel,
				rollbackError:
					rollbackError instanceof Error ? { message: rollbackError.message, name: rollbackError.name } : rollbackError,
			});
		}
		logger.error('V2 collateral prep tx failed [collateral-prep]', {
			walletDbId,
			walletAddress,
			serviceLabel,
			sharedTxId,
			error:
				submitError instanceof Error
					? { message: submitError.message, name: submitError.name, stack: submitError.stack }
					: submitError,
		});
		return {
			status: 'failed',
			reason: 'prep_tx_failed',
			details: submitError instanceof Error ? submitError.message : String(submitError),
		};
	}

	try {
		await prisma.transaction.update({
			where: { id: sharedTxId },
			data: {
				txHash: prepTxHash,
				// Refresh lastCheckedAt: this is the moment we LEARN the tx is
				// in-flight on chain. Resetting the debounce here means the next
				// `wallet-timeouts` poll happens ~1 minute after submission, which
				// is roughly when blockfrost is first able to confirm a freshly
				// landed tx — a perfect time to free the wallet on a clean
				// fetchTxInfo() hit.
				lastCheckedAt: new Date(),
			},
		});
	} catch (updateError) {
		// Hash-recording failure is non-fatal but is the SECOND gas-loop hazard
		// from this helper's audit: with txHash still null in the DB but the
		// tx already on chain, wallet-timeouts hits its `txHash == null`
		// branch (see WALLET_LOCK_TIMEOUT_INTERVAL handler in
		// wallet-timeouts/service.ts) and forcibly clears the wallet's
		// pendingTransactionId + lockedAt after the timeout. That itself is
		// fine — the on-chain prep tx propagates UTxOs the next helper
		// invocation will see — BUT if blockfrost hasn't yet indexed those
		// new UTxOs at the moment the next action tick runs, the helper
		// would observe the same "no collateral" state and submit a SECOND
		// prep tx (= second gas burn). The window is bounded (one extra
		// prep tx) and only triggers on a rare DB update failure right
		// after a successful chain submit; logging at WARN so we can spot
		// it in CI.
		logger.warn('V2 collateral prep post-submit hash update failed [collateral-prep]', {
			walletDbId,
			walletAddress,
			serviceLabel,
			sharedTxId,
			prepTxHash,
			error: updateError instanceof Error ? { message: updateError.message, name: updateError.name } : updateError,
		});
	}

	logger.warn('V2 collateral prep tx submitted; deferring action until confirmed [collateral-prep]', {
		walletDbId,
		walletAddress,
		prepTxHash,
		sharedTxId,
		serviceLabel,
		utxoCountBefore: classification.utxoCount,
		hadGoodCollateral: classification.hasGoodCollateral,
		totalLovelaceBefore: classification.totalLovelace.toString(),
	});

	return { status: 'deferred', prepTxHash };
}

/**
 * Clear the outer `lockedAt` set by `lockAndQueryX` when the helper bails
 * out without leaving a PendingTransaction behind. Without this, the
 * `wallet-timeouts` cron has no row to poll (its relation filter requires
 * `PendingTransaction != null`) and the wallet would stay locked until
 * `WALLET_LOCK_TIMEOUT_INTERVAL` elapsed AND a future Transaction row
 * happened to be created on it — which may never come.
 *
 * Invariant assumed by every call site: the wallet has NO connected
 * PendingTransaction at this point. `lockAndQueryX` only sets `lockedAt`;
 * the prep-tx pre-submit either hasn't run yet (insufficient_funds case)
 * or failed before connecting BlocksWallet (DB pre-submit failure case).
 * To keep this helper safe even if a future caller violates that
 * invariant, also issue `PendingTransaction.disconnect` — Prisma treats
 * a no-op disconnect on a 1-to-1 relation as a successful nothing-to-do,
 * so this never throws but DOES release a connection if one accidentally
 * exists.
 *
 * Idempotent and safe to call even when the caller did not pre-lock.
 */
/**
 * Pure builder for the Prisma update payload used by `unlockWalletLock`.
 * Exported so unit tests can pin the payload shape (both `lockedAt: null`
 * AND `PendingTransaction.disconnect: true`) without spinning up a DB or
 * jest module mocks.
 */
export function buildUnlockWalletLockData() {
	return {
		lockedAt: null,
		PendingTransaction: { disconnect: true as const },
	};
}

async function unlockWalletLock(walletDbId: string, serviceLabel: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: walletDbId, deletedAt: null },
			data: buildUnlockWalletLockData(),
		});
	} catch (error) {
		logger.warn('V2 collateral prep unlockWalletLock failed (non-fatal) [collateral-prep]', {
			walletDbId,
			serviceLabel,
			error: error instanceof Error ? { name: error.name, message: error.message } : error,
		});
	}
}
