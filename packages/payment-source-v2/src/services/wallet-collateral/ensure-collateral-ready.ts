import type { BlockfrostProvider, MeshWallet } from '@/services/shared';
import { Transaction as MeshTransaction } from '@/services/shared';
import { TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import { recordV2CollateralPrepHashDivergence } from '@masumi/payment-core/metrics';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { resolveTxHash, SLOT_CONFIG_NETWORK, unixTimeToEnclosingSlot } from '@meshsdk/core';
import type { Network, UTxO } from '@meshsdk/core';
import { isDefinitiveNodeRejection } from '@masumi/payment-core/submit-error-classifier';

/**
 * Current service-level wallet shape for collateral readiness:
 *   - one payment-key wallet UTxO of ≥ COLLATERAL_RESERVE_LOVELACE for the
 *     collateral input. Tokens on the same UTxO are FINE — Babbage added
 *     `collateral_return_output` + `total_collateral` (CIP-40), and Mesh-SDK
 *     1.9 auto-emits the return output when a token-bearing UTxO is declared
 *     as collateral, so the ledger accepts mixed-asset collateral inputs.
 *   - AT LEAST ONE additional wallet UTxO for the current V2 builders'
 *     separate-collateral reserve policy.
 *
 * Cardano does NOT forbid a VKey wallet UTxO from appearing in both
 * `inputs` and `collateral_inputs`. The real ledger constraint is that
 * collateral must be payment-key-locked, so script-locked UTxOs can never be
 * collateral. This helper still preserves a separate confirmed reserve so
 * successful script txs leave a ready collateral candidate for the next tick
 * and do not rely on Mesh coin selection sharing the collateral UTxO.
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
	/**
	 * Mesh-style network ('mainnet' | 'preprod'). Required so we can pick an
	 * explicit `invalidHereafter` slot for the prep tx — the slot is persisted
	 * alongside `intendedTxHash` and the funding-reconciliation worker uses it
	 * as the TTL boundary past which an unfound Pending row is provably lost
	 * and can be safely reverted.
	 */
	network: Network;
	/** Short label for log lines so a single grep can attribute prep calls to
	 *  the service that triggered them (e.g. 'request-refund'). */
	serviceLabel: string;
};

export type WalletStateClassification = {
	hasGoodCollateral: boolean;
	utxoCount: number;
	totalLovelace: bigint;
	/** Diagnostic only — sum of lovelace across UTxOs that hold ONLY lovelace
	 *  (no other tokens). Not a gate. Babbage (CIP-40) allows mixed-asset
	 *  UTxOs as collateral, and mesh-SDK 1.9's `sendAssets` for the prep tx
	 *  transparently peels lovelace off a token-bearing UTxO (the bundled
	 *  tokens flow into the change output). The classifier no longer
	 *  differentiates between pure and mixed UTxOs for readiness or
	 *  prep-funding — `totalLovelace` is the sole funding gate. This field
	 *  is retained as an operator-facing diagnostic so token-fragmentation
	 *  state is visible in logs without re-walking the UTxO list. */
	pureLovelaceTotal: bigint;
	/** Diagnostic only — true when at least one UTxO is pure ADA. Not a gate;
	 *  mixed-asset UTxOs are perfectly valid collateral inputs since Babbage. */
	hasPureAdaUtxo: boolean;
	/** Per-UTxO asset summaries, surfaced so the caller's ERROR log can
	 *  point an operator at exactly which UTxOs carry tokens vs pure ADA
	 *  without re-walking the UTxO list. */
	utxoAssetSummaries: Array<{
		txHash: string;
		outputIndex: number;
		lovelace: string;
		assetUnits: string[];
	}>;
	ready: boolean;
	fundedForPrep: boolean;
};

/**
 * Pure classification of a wallet's UTxO set against the collateral
 * readiness invariant. Extracted as a free function so the decision logic
 * is unit-testable without mocking mesh's Transaction class.
 *
 *   - `hasGoodCollateral` — at least one UTxO holds ≥ COLLATERAL_RESERVE_LOVELACE.
 *     Token-bearing UTxOs ARE acceptable since Babbage: the ledger accepts
 *     them as collateral inputs as long as the tx body declares a
 *     `collateral_return_output` for the non-ADA assets and a `total_collateral`
 *     field for the ADA portion (CIP-40). Mesh-SDK 1.9 emits both automatically
 *     when a token-bearing UTxO is selected for collateral, so no special
 *     handling is required at this layer.
 *   - `utxoCount` — total UTxOs in the wallet (the second UTxO requirement
 *     is a current service/builder invariant; see the module-level note).
 *   - `totalLovelace` — sum of `lovelace` across every UTxO, used to gate
 *     the prep-tx build (insufficient funds bail-out).
 *   - `ready` — composite gate: `hasGoodCollateral && utxoCount >= 2`.
 *   - `fundedForPrep` — `totalLovelace >= PREP_TX_MIN_LOVELACE`. Mesh's
 *     `sendAssets({...}, [{ unit: 'lovelace', quantity: 5_000_000 }])` works
 *     fine over token-bearing UTxOs: the explicit output carries only 5 ADA,
 *     and mesh's coin selector emits a change output that captures the
 *     remaining lovelace AND the bundled tokens. The previous pure-ADA-only
 *     gate was overly conservative.
 *   - `pureLovelaceTotal` — sum of `lovelace` across pure-ADA-only UTxOs.
 *     Retained as a diagnostic so operators can see token-fragmentation
 *     state, but NOT used as a gate.
 *   - `hasPureAdaUtxo` — true when at least one UTxO is pure ADA. Diagnostic
 *     only; mixed-asset UTxOs are perfectly valid collateral inputs.
 *   - `utxoAssetSummaries` — per-UTxO asset summary surfaced so the caller
 *     can log exactly which UTxOs carry tokens vs pure ADA without re-walking
 *     the UTxO list.
 */
export function classifyWalletState(utxos: UTxO[]): WalletStateClassification {
	let totalLovelace = 0n;
	let pureLovelaceTotal = 0n;
	let hasGoodCollateral = false;
	let hasPureAdaUtxo = false;
	const utxoAssetSummaries: WalletStateClassification['utxoAssetSummaries'] = [];

	for (const utxo of utxos) {
		const amounts = utxo.output.amount;
		let lovelaceForThisUtxo = 0n;
		let isPureAda = true;
		const assetUnits: string[] = [];
		for (const asset of amounts) {
			if (asset.unit === 'lovelace' || asset.unit === '') {
				lovelaceForThisUtxo += BigInt(asset.quantity);
			} else {
				isPureAda = false;
				assetUnits.push(asset.unit);
			}
		}
		totalLovelace += lovelaceForThisUtxo;
		if (isPureAda) {
			pureLovelaceTotal += lovelaceForThisUtxo;
			hasPureAdaUtxo = true;
		}
		// Mixed-asset UTxOs ARE valid collateral inputs since Babbage (CIP-40);
		// drop the previous purity gate. The lovelace floor still applies.
		if (lovelaceForThisUtxo >= COLLATERAL_RESERVE_LOVELACE) {
			hasGoodCollateral = true;
		}
		utxoAssetSummaries.push({
			txHash: utxo.input.txHash,
			outputIndex: utxo.input.outputIndex,
			lovelace: lovelaceForThisUtxo.toString(),
			assetUnits,
		});
	}

	const utxoCount = utxos.length;
	const ready = hasGoodCollateral && utxoCount >= 2;
	// Use TOTAL lovelace (not pure-only). Mesh's `sendAssets` selects coverage
	// across any UTxOs the wallet holds, including token-bearing ones; the
	// explicit 5-ADA output is satisfied first, and the remaining lovelace +
	// bundled tokens flow into the change output. The previous purity gate
	// was a misreading of mesh's behavior — it could peel ADA off a token-
	// bearing UTxO all along.
	const fundedForPrep = totalLovelace >= PREP_TX_MIN_LOVELACE;

	return {
		hasGoodCollateral,
		utxoCount,
		totalLovelace,
		pureLovelaceTotal,
		hasPureAdaUtxo,
		utxoAssetSummaries,
		ready,
		fundedForPrep,
	};
}

/**
 * Before each V2 script-spending action: confirm the wallet has both a
 * collateral-eligible UTxO (≥ COLLATERAL_RESERVE_LOVELACE, tokens permitted)
 * and at least one additional UTxO to feed the fee input.
 *
 * Outcomes:
 *   - 'ready'                          — wallet meets the invariant;
 *                                        caller proceeds.
 *   - 'deferred'                       — wallet had enough total lovelace but
 *                                        only one UTxO (or no UTxO ≥ 5 ADA).
 *                                        We submitted a self-send prep tx;
 *                                        caller MUST return without consuming
 *                                        the lock. wallet-timeouts (or
 *                                        tx-sync once it observes the prep
 *                                        txHash) will clear the lock once
 *                                        the prep tx confirms. Mixed-asset
 *                                        UTxOs feed the prep tx fine — mesh
 *                                        emits a change output that carries
 *                                        any bundled tokens.
 *   - 'failed'                         — either the wallet is too underfunded
 *                                        in total lovelace to even build a
 *                                        prep tx,
 *                                        or the prep tx itself failed to
 *                                        submit. Caller treats this as a
 *                                        transient operational error: leave
 *                                        items queued and let the next tick
 *                                        re-evaluate.
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
	const { walletDbId, walletAddress, meshWallet, utxos, serviceLabel, network } = params;
	const classification = classifyWalletState(utxos);

	if (classification.ready) {
		return { status: 'ready' };
	}

	// Previously this branch existed to surface "money trapped in token-bearing
	// UTxOs" as a separate status, because the prep tx was thought to need
	// pure-ADA inputs. Babbage (CIP-40) + mesh-SDK 1.9 dispelled both halves
	// of that assumption: (a) mixed-asset UTxOs ARE valid collateral inputs
	// with auto-emitted collateral_return_output, and (b) mesh's `sendAssets`
	// transparently peels lovelace off a token-bearing UTxO and routes the
	// bundled tokens into the change output. The branch is removed; the
	// `fundedForPrep` gate below now uses `totalLovelace` and treats mixed
	// and pure UTxOs equivalently.

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
			pureLovelaceTotal: classification.pureLovelaceTotal.toString(),
			hasPureAdaUtxo: classification.hasPureAdaUtxo,
			minRequiredLovelace: PREP_TX_MIN_LOVELACE.toString(),
			note: 'wallet does not hold enough TOTAL lovelace to fund a collateral-prep tx. Mixed-asset UTxOs are acceptable inputs; this log repeats every scheduler tick until operator funds the wallet.',
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
			details: `wallet has ${classification.totalLovelace.toString()} lovelace across ${classification.utxoCount} UTxO(s); need at least ${PREP_TX_MIN_LOVELACE.toString()} total lovelace to build collateral prep tx (mixed-asset UTxOs accepted)`,
		};
	}

	// Build the prep tx. Send the collateral reserve explicitly back to
	// the wallet's own address; mesh will then add a change output for
	// the remainder, naturally restoring the separate reserve/change shape
	// the current V2 builders expect on the next script tx.
	const meshTx = new MeshTransaction({
		initiator: meshWallet,
		fetcher: params.blockchainProvider,
	}).setMetadata(674, {
		msg: ['Masumi', 'CollateralPrep'],
	});

	meshTx.sendAssets({ address: walletAddress }, [
		{ unit: 'lovelace', quantity: COLLATERAL_RESERVE_LOVELACE.toString() },
	]);

	// Explicit invalid_hereafter ~5 minutes ahead so we can persist it as the
	// TTL boundary for `funding-reconciliation`. Without an explicit TTL the
	// prep txBody could remain submittable indefinitely, defeating the
	// reconciliation worker's "after TTL elapsed, safe to revert" logic.
	const invalidHereafterSlot = unixTimeToEnclosingSlot(Date.now() + 5 * 60 * 1000, SLOT_CONFIG_NETWORK[network]) + 5;
	meshTx.setTimeToExpire(invalidHereafterSlot.toString());

	// Build + sign FIRST so we can compute the deterministic txHash and
	// persist it alongside `invalidHereafterSlot` BEFORE broadcasting. On an
	// ambiguous submit failure (network/transport throw with unknown chain
	// outcome) the funding-reconciliation worker queries the chain for this
	// exact hash and either promotes it to txHash or — after the TTL slot
	// provably elapsed — reverts safely. Without this pre-recording, a
	// timeout-but-tx-actually-landed edge case would silently free the
	// wallet, and the next ensureCollateralReady tick could submit a SECOND
	// prep tx with different UTxOs, burning duplicate fees (~0.5-1 ADA per
	// occurrence). Same root cause as the funding double-lock window (#2)
	// but lower-stakes; mitigated identically via intendedTxHash + TTL.
	let unsignedTx: string;
	let signedTx: string;
	let intendedTxHash: string;
	try {
		unsignedTx = await meshTx.build();
		signedTx = await meshWallet.signTx(unsignedTx);
		intendedTxHash = resolveTxHash(signedTx);
	} catch (buildError) {
		logger.error('V2 collateral prep build/sign failed [collateral-prep]', {
			walletDbId,
			walletAddress,
			serviceLabel,
			error:
				buildError instanceof Error
					? { message: buildError.message, name: buildError.name, stack: buildError.stack }
					: buildError,
		});
		// No DB row was created and no tx left the host — unlock the outer
		// `lockAndQueryX` lock so the next tick can retry.
		await unlockWalletLock(walletDbId, serviceLabel);
		return {
			status: 'failed',
			reason: 'prep_tx_failed',
			details: buildError instanceof Error ? buildError.message : String(buildError),
		};
	}

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
								// Pre-recording these BEFORE submit is the core of the
								// double-fee-burn fix — see funding-reconciliation worker.
								intendedTxHash,
								invalidHereafterSlot: BigInt(invalidHereafterSlot),
								BlocksWallet: { connect: { id: walletDbId } },
							},
						});
						return sharedTx.id;
					},
					{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
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
		// No PendingTransaction was successfully connected — tx has NOT been
		// broadcast yet. Unlock explicitly so the next tick can retry.
		await unlockWalletLock(walletDbId, serviceLabel);
		return {
			status: 'failed',
			reason: 'prep_tx_failed',
			details: dbError instanceof Error ? dbError.message : String(dbError),
		};
	}

	let prepTxHash: string;
	try {
		prepTxHash = await meshWallet.submitTx(signedTx);
	} catch (submitError) {
		const definitive = isDefinitiveNodeRejection(submitError);
		if (!definitive) {
			// AMBIGUOUS — the tx MAY be on chain. Do NOT mark RolledBack, do
			// NOT free the wallet. Leave the row Pending with
			// `intendedTxHash` + `invalidHereafterSlot` set; the
			// `funding-reconciliation` worker will resolve it:
			//   - chain says found → promote to txHash; wallet-timeouts'
			//     confirmation path unlocks the wallet on confirmation
			//   - chain says not-found AND past TTL slot → safely revert
			//     (mark RolledBack, free wallet via updateMany predicate)
			// Walking through the funding-reconciliation revert code:
			// it iterates `purchaseRequest.findMany({ currentTransactionId })`
			// which returns 0 rows for prep txs (no PurchaseRequest points
			// at the prep Tx), then frees the wallet + marks RolledBack —
			// exactly what we want for the prep-tx revert case.
			logger.warn('V2 collateral prep submit AMBIGUOUS; leaving for funding-reconciliation [collateral-prep]', {
				walletDbId,
				walletAddress,
				serviceLabel,
				sharedTxId,
				intendedTxHash,
				invalidHereafterSlot,
				error: submitError instanceof Error ? { message: submitError.message, name: submitError.name } : submitError,
			});
			return {
				status: 'deferred',
				prepTxHash: intendedTxHash,
			};
		}

		// DEFINITIVE rejection — the node returned a ledger-side validation
		// error before broadcasting. Safe to revert state and free the wallet.
		try {
			await retryOnSerializationConflict(
				() =>
					prisma.$transaction(async (tx) => {
						// Guard against clobbering a concurrent batch's pendingTransactionId:
						// only disconnect if the wallet still points at OUR sharedTxId.
						const updated = await tx.hotWallet.updateMany({
							where: { id: walletDbId, deletedAt: null, pendingTransactionId: sharedTxId },
							data: {
								pendingTransactionId: null,
								lockedAt: null,
							},
						});
						if (updated.count === 0) {
							logger.warn(
								'V2 collateral prep rollback: HotWallet.pendingTransactionId no longer matches sharedTxId; skipping wallet disconnect (race with concurrent writer) [collateral-prep]',
								{ walletDbId, sharedTxId },
							);
						}
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
		logger.error('V2 collateral prep tx definitively rejected [collateral-prep]', {
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

	// Node returned the hash. We log loudly if it diverges from our
	// deterministic intent (signals an upstream hash-computation mismatch
	// between our offline build and mesh/cardano-node) but TRUST THE NODE
	// as ground truth: the node-returned hash IS the hash that landed on
	// chain. Returning the intended hash here would mis-track the tx in
	// funding-reconciliation (it queries `intendedTxHash` on chain), which
	// would TTL-revert the row and re-attempt with the same already-spent
	// inputs on the next tick. Falling through to the normal write path
	// records `txHash = prepTxHash` so tx-sync picks it up directly.
	if (prepTxHash !== intendedTxHash) {
		logger.error(
			'V2 collateral prep: node returned divergent txHash; trusting node and writing as txHash [collateral-prep]',
			{
				walletDbId,
				sharedTxId,
				intendedTxHash,
				nodeTxHash: prepTxHash,
			},
		);
		// Emit a dedicated alerting metric. Non-zero values here indicate a
		// hash-computation mismatch between our offline build and the live
		// mesh/cardano-node; operators should investigate (likely root cause
		// is mesh cost-model arrays out of sync with chain, see
		// `mesh-cost-model-sync`). Logger noise alone is easy to filter
		// past; metric+alert wires this into PagerDuty / on-call rotation.
		recordV2CollateralPrepHashDivergence({ wallet_db_id: walletDbId });
	}

	try {
		// Wrap the post-submit hash update in retryOnSerializationConflict so a
		// transient pool / serialization failure doesn't drop us into the
		// gas-loop hazard below. The retry's bounded backoff covers the common
		// transient case (concurrent writer, P2028, brief pool pressure); the
		// updateError catch arm below remains the last-resort fallback.
		await retryOnSerializationConflict(
			() =>
				prisma.transaction.update({
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
				}),
			{ label: 'collateral-prep-post-submit-hash' },
		);
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
		// prep tx (= second gas burn). The retry-wrapped update above covers
		// the common transient case; this arm logs the rare residual.
		logger.warn('V2 collateral prep post-submit hash update failed after retries [collateral-prep]', {
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
