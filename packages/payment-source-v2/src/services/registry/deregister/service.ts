import { PaymentSourceType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { LanguageVersion, UTxO } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import { sortAndLimitUtxos } from '@/utils/utxo';
import {
	connectExistingTransaction,
	createMeshProvider,
	createPendingTransaction,
	disconnectTransactionWallet,
	loadHotWalletSession,
} from '@/services/shared';
import {
	findRegistryTokenUtxo,
	generateRegistryDeregisterTransactionAutomaticFees,
	getBurnRedeemerAlternative,
	resolveRegistryDeregistrationWallet,
} from '@/services/registry/shared';
import {
	assertNoCollateralOverlap,
	assertTxSizeWithinLimit,
	pickBatchCollateral,
	shrinkBatchToFit,
	WALLET_SPLITTER_LOVELACE,
} from '../../../builders/batch-helpers';
import {
	type BatchRegistryBurnItem,
	generateRegistryBatchDeregisterTransactionAutomaticFees,
} from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordRegistryPrepFailure,
	resetRegistryPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';

// V2 registry deregister sizing. Burn legs all share one BurnAction redeemer,
// so per-item cost is dominated by tx-size (each burn pulls in the asset's
// UTxO and emits no continuation output). The cap matches the register side.
const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

type ValidatedDeregistrationItem = {
	request: RegistryRequestRecord;
	item: BatchRegistryBurnItem;
	deregistrationWalletId: string;
};

function validateDeregistrationRequest(request: { agentIdentifier: string | null }): void {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is not set');
	}
}

/**
 * Terminate a deregister attempt: stamp the failure reason on the request and
 * release the wallet lock so a fresh attempt (or a manual operator action) can
 * proceed.
 *
 * The two writes are intentionally NOT wrapped in a `prisma.$transaction`:
 *
 *  - "Partial failure" here means the first update (request → DeregistrationFailed)
 *    succeeds but the second update (hotWallet.lockedAt = null) throws — e.g.
 *    a Prisma connection drop or a serialization conflict on the wallet row.
 *    The DB ends up with the request marked failed while the wallet stays
 *    locked. Wrapping in a `$transaction` would roll BOTH back on partial
 *    failure, leaving the request in its original `DeregistrationRequested`
 *    state and inviting the worker to retry indefinitely against an error it
 *    just classified as terminal.
 *
 *  - The current shape prefers the "request failure stamped, wallet maybe
 *    still locked" outcome because the wallet is recoverable by the
 *    `wallet-timeouts` service: it sweeps wallets whose `lockedAt < threshold`
 *    AND have no in-flight `PendingTransaction`, and clears the lock. The
 *    operational consequence of partial failure is therefore a delayed
 *    unlock (one wallet-timeouts tick), not stuck state.
 *
 * If both writes succeed (the happy path), the wallet unlocks immediately and
 * the worker picks up the next request on the next scheduler tick.
 */
async function markRequestFailed(
	request: RegistryRequestRecord,
	error: unknown,
	options: { unlockWallet?: boolean } = {},
): Promise<void> {
	const unlockWallet = options.unlockWallet ?? true;
	logger.error(`Error deregistering V2 agent ${request.id}`, { error });
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.DeregistrationFailed,
			error: interpretBlockchainError(error),
		},
	});
	// Skip the wallet unlock in the per-item validation loop: the shared wallet
	// lock must survive while the batch keeps building the remaining validated
	// items (the terminal paths — all-failed unlock, submit success, batch-bail —
	// free it). Releasing it mid-batch lets a concurrent service grab the wallet
	// and submit a conflicting tx from the same UTxO set.
	if (!unlockWallet) {
		return;
	}
	const walletToUnlock = request.DeregistrationHotWallet ?? request.SmartContractWallet;
	try {
		await prisma.hotWallet.update({
			where: { id: walletToUnlock.id, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (unlockError) {
		// Intentionally NOT a $transaction with the request update above — see the
		// function-level JSDoc for the full rationale. The operational consequence
		// of this partial failure is that the hot wallet remains locked until the
		// `wallet-timeouts` sweeper next clears stale locks (default ~30 min).
		// Logged at WARN so it shows up in operator dashboards without paging.
		logger.warn(
			'V2 deregister markRequestFailed: request failure stamped but hot wallet unlock failed; wallet may remain locked for up to 30min until wallet-timeouts sweeps',
			{
				requestId: request.id,
				hotWalletId: walletToUnlock.id,
				error:
					unlockError instanceof Error
						? { message: unlockError.message, stack: unlockError.stack, name: unlockError.name }
						: unlockError,
			},
		);
	}
}

/**
 * Release the hot wallet lock without changing any request state. Used by
 * wallet-level batch-bail paths where every request was waiting on the same
 * wallet — items stay queued for the next scheduler tick instead of being
 * terminated en masse.
 */
async function unlockHotWallet(hotWalletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: hotWalletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to release hot wallet lock after V2 deregister batch bail-out', {
			hotWalletId,
			error,
		});
	}
}

/**
 * Per-request validation. Locates the asset's UTxO in the wallet and builds
 * the per-item burn payload. Throws on validation failure — caller maps the
 * throw to DeregistrationFailed.
 */
function validateAndBuildItem(request: RegistryRequestRecord, utxos: UTxO[]): ValidatedDeregistrationItem {
	validateDeregistrationRequest(request);
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is required for deregistration');
	}
	const assetUtxo = findRegistryTokenUtxo(utxos, request.agentIdentifier);
	const assetName = extractAssetName(request.agentIdentifier);
	const deregistrationWallet = resolveRegistryDeregistrationWallet(request);
	return {
		request,
		deregistrationWalletId: deregistrationWallet.id,
		item: { assetName, assetUtxo },
	};
}

async function processSingleDeregistration(
	validated: ValidatedDeregistrationItem,
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	const request = validated.request;
	const deregistrationWallet = resolveRegistryDeregistrationWallet(request);
	const walletSession = await loadHotWalletSession({
		network: paymentSource.network,
		rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: deregistrationWallet.Secret.encryptedMnemonic,
		hotWalletId: deregistrationWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		throw new Error('No UTXOs found for the wallet');
	}
	const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
	const collateralCheck = await ensureCollateralReady({
		walletDbId: deregistrationWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'registry-deregister-single',
	});
	if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
		// Wallet cannot fund the collateral prep tx for this attempt. Fail with a
		// clear reason (instead of silently deferring forever, which looks like
		// "stuck, nothing happens") so the request lands in *Failed, is visible,
		// and can be retried once the wallet is funded (deregister resets in
		// place via the deregister route; register recreates). markRequestFailed
		// unlocks the wallet on this single-item terminal path.
		const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the wallet with ADA and retry.`;
		await markRequestFailed(request, new Error(failureMessage));
		return;
	}
	if (collateralCheck.status === 'failed') {
		// reason === 'prep_tx_failed' (transient; wallet already unlocked). Bound
		// the retries so a deterministically-failing prep surfaces as
		// DeregistrationFailed instead of looping forever.
		const reachedLimit = await recordRegistryPrepFailure(request.id);
		if (reachedLimit) {
			await markRequestFailed(
				request,
				new Error(
					`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${collateralCheck.details}. Check the wallet's UTxO set and retry.`,
				),
			);
		}
		return;
	}
	if (collateralCheck.status !== 'ready') {
		// status === 'deferred': a collateral prep tx is in flight; keep the
		// request queued so the next scheduler tick re-picks it up once the prep
		// tx confirms.
		return;
	}
	// Collateral ready — clear any transient prep-failure count.
	await resetRegistryPrepFailureCount(request.id);
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is required for deregistration');
	}
	const tokenUtxo = findRegistryTokenUtxo(utxos, request.agentIdentifier);
	const limitedFilteredUtxos = sortAndLimitUtxos(utxos, 8000000);
	const collateralUtxo = limitedFilteredUtxos[0];
	if (collateralUtxo == null) {
		throw new Error('Collateral UTXO not found');
	}
	const assetName = extractAssetName(request.agentIdentifier);
	const unsignedTx = await generateRegistryDeregisterTransactionAutomaticFees(
		blockchainProvider,
		network,
		script,
		address,
		policyId,
		assetName,
		tokenUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		getBurnRedeemerAlternative(PaymentSourceType.Web3CardanoV2),
		paymentSource.PaymentSourceConfig.rpcProviderApiKey,
		// V2 single-item splitter — see authorize-refund/service.ts.
		WALLET_SPLITTER_LOVELACE,
	);
	const signedTx = await wallet.signTx(unsignedTx);

	// Submit FIRST, then write DB. See register/service.ts single-item
	// path for full rationale. On submit failure, no orphan Transaction
	// row to clean up; just revert state back to DeregistrationRequested
	// and clear the wallet lock so the next tick can retry.
	let newTxHash: string;
	try {
		newTxHash = await wallet.submitTx(signedTx);
	} catch (error) {
		logger.error('Error submitting V2 deregister single-item tx', { error, requestId: request.id });
		await prisma.registryRequest.update({
			where: { id: request.id },
			data: {
				state: RegistrationState.DeregistrationRequested,
				DeregistrationHotWallet: {
					update: {
						lockedAt: null,
					},
				},
			},
		});
		return;
	}

	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);

	await retryOnSerializationConflict(
		() =>
			prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.DeregistrationInitiated,
					...createPendingTransaction(deregistrationWallet.id, newTxHash),
				},
			}),
		{ label: 'v2-deregister-single-post-submit' },
	);
	logger.debug(`Created V2 deregister transaction (single-item fallback):
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function deRegisterAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.DeregistrationRequested,
			maxBatchSize: REGISTRY_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.RegistryRequest.length == 0) return;
				logger.info(
					`Deregistering ${paymentSource.RegistryRequest.length} V2 agents for payment source ${paymentSource.id}`,
				);
				const network = convertNetwork(paymentSource.network);
				const registryRequests = paymentSource.RegistryRequest;
				if (registryRequests.length == 0) return;

				const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
				const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

				// All requests in this batch share the same locked hot wallet
				// (either SmartContractWallet for self-deregister, or the
				// DeregistrationHotWallet if set). One wallet session covers
				// the whole batch.
				const firstRequest = registryRequests[0];
				const deregistrationWallet = resolveRegistryDeregistrationWallet(firstRequest);

				let walletSession;
				try {
					walletSession = await loadHotWalletSession({
						network: paymentSource.network,
						rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
						encryptedMnemonic: deregistrationWallet.Secret.encryptedMnemonic,
						hotWalletId: deregistrationWallet.id,
					});
				} catch (error) {
					logger.warn(
						'V2 deregister batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
						{
							error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
							batchSize: registryRequests.length,
						},
					);
					// Wallet-load failure is NOT a per-item failure: every
					// request was waiting on the same wallet. Unlock and
					// leave the items queued; next tick re-batches them.
					await unlockHotWallet(deregistrationWallet.id);
					return;
				}
				const { wallet, utxos, address } = walletSession;
				if (utxos.length === 0) {
					logger.warn(
						'V2 deregister batch hot wallet has no UTxOs; leaving items in pool for next tick [batch-fallback]',
						{
							batchSize: registryRequests.length,
						},
					);
					// Empty wallet — transient operational state. Leave
					// items queued; next tick after wallet has UTxOs
					// re-batches them.
					await unlockHotWallet(deregistrationWallet.id);
					return;
				}

				const collateralCheck = await ensureCollateralReady({
					walletDbId: deregistrationWallet.id,
					walletAddress: address,
					meshWallet: wallet,
					utxos,
					blockchainProvider,
					network,
					serviceLabel: 'registry-deregister-batch',
				});
				if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
					// Wallet cannot fund collateral for the whole batch (all items share
					// this wallet). Fail every item with a clear reason instead of
					// silently deferring forever, so they land in DeregistrationFailed,
					// are visible, and can be retried once the wallet is funded (the
					// deregister route resets each in place).
					const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the wallet with ADA and retry.`;
					await Promise.allSettled(
						registryRequests.map((request) => markRequestFailed(request, new Error(failureMessage))),
					);
					return;
				}
				if (collateralCheck.status === 'failed') {
					// reason === 'prep_tx_failed' (transient; wallet already unlocked).
					// Bound per-request retries so a deterministically-failing prep
					// surfaces as DeregistrationFailed instead of looping forever.
					await Promise.allSettled(
						registryRequests.map(async (request) => {
							const reachedLimit = await recordRegistryPrepFailure(request.id);
							if (reachedLimit) {
								await markRequestFailed(
									request,
									new Error(
										`Collateral preparation failed repeatedly (>= ${MAX_COLLATERAL_PREP_FAILURES} attempts): ${collateralCheck.details}. Check the wallet's UTxO set and retry.`,
									),
								);
							}
						}),
					);
					return;
				}
				if (collateralCheck.status !== 'ready') {
					return;
				}
				// Collateral ready — clear any transient prep-failure count on every item.
				await Promise.allSettled(registryRequests.map((request) => resetRegistryPrepFailureCount(request.id)));

				// Per-request validation: each item needs its asset UTxO in
				// the wallet. Missing-asset failures become per-item DB
				// failures.
				const validated: ValidatedDeregistrationItem[] = [];
				for (const request of registryRequests) {
					try {
						validated.push(validateAndBuildItem(request, utxos));
					} catch (error) {
						// Mid-batch: keep the shared wallet lock (see markRequestFailed).
						await markRequestFailed(request, error, { unlockWallet: false });
					}
				}

				if (validated.length === 0) {
					logger.info('No V2 deregister requests passed validation this tick');
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}

				// Pick collateral that is NOT the asset-holding UTxO of any
				// item — phase-1 Conway rejects collateral overlap and the
				// asset UTxOs are part of the spending set for the burn.
				const excludeRefs = validated.map((v) => v.item.assetUtxo.input);
				const collateralUtxo = pickBatchCollateral(utxos, excludeRefs);
				if (collateralUtxo == null) {
					// Wallet has no separate collateral candidate — typical for a
					// just-registered seller wallet where the agent NFT UTxO is
					// the only UTxO. The V1 single-tx builder handles this by
					// passing the asset UTxO as BOTH `assetUtxo` and
					// `collateralUtxo` (mesh-sdk routes `.txIn(...)` and
					// `.txInCollateral(...)` into separate body fields and
					// dedupes at assembly). Fall back to the per-item single-tx
					// path which already uses that pattern via
					// `generateRegistryDeregisterTransactionAutomaticFees`.
					logger.warn(
						'V2 deregister batch could not find separate collateral UTxO; falling back to single-item [batch-fallback] per-request processing [batch-fallback]',
					);
					await fallbackToSingleItems(validated, paymentSource, network, script, policyId);
					return;
				}

				// Filter the wallet UTxOs that flow into the tx (used for fee /
				// change) so the asset-holding UTxOs and the collateral don't
				// appear twice. The batch builder de-dupes internally, but a
				// clean filter keeps the tx body lean.
				const assetUtxoKeys = new Set(
					validated.map((v) => `${v.item.assetUtxo.input.txHash}#${v.item.assetUtxo.input.outputIndex}`),
				);
				const collateralUtxoKey = `${collateralUtxo.input.txHash}#${collateralUtxo.input.outputIndex}`;
				const walletUtxos = utxos.filter((utxo) => {
					const key = `${utxo.input.txHash}#${utxo.input.outputIndex}`;
					if (key === collateralUtxoKey) return false;
					if (assetUtxoKeys.has(key)) return false;
					return true;
				});

				// Tx-size guard via shrinkBatchToFit. We probe the
				// no-collateral-overlap invariant up front; the actual size
				// check happens after the build pass below.
				const shrinkResult = shrinkBatchToFit(validated, (subset) => {
					try {
						assertNoCollateralOverlap(
							collateralUtxo,
							subset.map((v) => v.item.assetUtxo),
						);
						return { ok: true };
					} catch {
						return { ok: false, reason: 'collateral' };
					}
				});

				if (shrinkResult.fit.length === 0) {
					logger.error('V2 deregister batch could not satisfy collateral non-overlap invariant', {
						reason: shrinkResult.reason,
					});
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}
				if (shrinkResult.dropped.length > 0) {
					logger.warn(
						`V2 deregister batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
					);
				}

				const fit = shrinkResult.fit;
				const items = fit.map((v) => v.item);

				let unsignedTx: string;
				try {
					// `createMeshProvider` returns the V1 mesh `BlockfrostProvider`
					// (shared/provider-factory.ts is V1-pinned), but the V2 builder is
					// typed against the V2 mesh `BlockfrostProvider`. Their runtime
					// shapes are identical for the methods we touch (`evaluateTx`,
					// `fetchProtocolParameters`); the type mismatch is purely nominal
					// from TypeScript's private-property check. See
					// docs/adr/0005-meshsdk-version-pinning-v1-v2.md.
					unsignedTx = await generateRegistryBatchDeregisterTransactionAutomaticFees(
						asV2Provider(blockchainProvider),
						network,
						script,
						address,
						policyId,
						items,
						collateralUtxo,
						walletUtxos,
						paymentSource.PaymentSourceConfig.rpcProviderApiKey,
					);
					assertTxSizeWithinLimit(unsignedTx, 'v2-registry-batch-deregister');
				} catch (batchError) {
					logger.warn('V2 deregister batch build failed; falling back to single-item processing [batch-fallback]', {
						error:
							batchError instanceof Error
								? { message: batchError.message, stack: batchError.stack, name: batchError.name }
								: batchError,
						batchSize: fit.length,
					});
					await fallbackToSingleItems(fit, paymentSource, network, script, policyId);
					return;
				}

				let signedTx: string;
				try {
					signedTx = await wallet.signTx(unsignedTx);
				} catch (signError) {
					logger.warn('V2 deregister batch sign failed; falling back to single-item processing [batch-fallback]', {
						error:
							signError instanceof Error
								? { message: signError.message, stack: signError.stack, name: signError.name }
								: signError,
					});
					await fallbackToSingleItems(fit, paymentSource, network, script, policyId);
					return;
				}

				// Pre-submit: create ONE shared Transaction row carrying
				// BlocksWallet → deregistration wallet, then connect every
				// fit item's CurrentTransaction to that shared Tx so tx-sync
				// fires the wallet unlock exactly once per batch.
				let sharedTxId: string;
				try {
					sharedTxId = await retryOnSerializationConflict(
						() =>
							prisma.$transaction(
								async (tx) => {
									const sharedTx = await tx.transaction.create({
										data: {
											status: TransactionStatus.Pending,
											// `lastCheckedAt: now` required so wallet-timeouts can poll this row.
											// See docs/adr/0006 and docs/adr/0007 for the full rationale.
											lastCheckedAt: new Date(),
											BlocksWallet: { connect: { id: deregistrationWallet.id } },
										},
									});
									for (const v of fit) {
										await tx.registryRequest.update({
											where: { id: v.request.id },
											data: {
												state: RegistrationState.DeregistrationInitiated,
												...connectExistingTransaction(sharedTx.id),
											},
										});
									}
									return sharedTx.id;
								},
								{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
							),
						{ label: 'v2-deregister-batch-tx' },
					);
				} catch (dbError) {
					logger.error('V2 deregister batch DB pre-submit update failed', { error: dbError });
					await prisma.hotWallet.update({
						where: { id: deregistrationWallet.id, deletedAt: null },
						data: { lockedAt: null },
					});
					return;
				}

				let newTxHash: string;
				try {
					newTxHash = await wallet.submitTx(signedTx);
				} catch (submitError) {
					logger.warn('V2 deregister batch submit failed; rolling back DB and retrying as single items', {
						error:
							submitError instanceof Error
								? { message: submitError.message, stack: submitError.stack, name: submitError.name }
								: submitError,
					});
					try {
						await retryOnSerializationConflict(
							() =>
								prisma.$transaction(
									async (tx) => {
										await tx.transaction.update({
											where: { id: sharedTxId },
											data: {
												...disconnectTransactionWallet(),
												// Mark the orphan shared row as RolledBack: the per-item reverts
												// below restore each request's CurrentTransaction to its pre-batch
												// value, leaving this row with no back-references. Without an
												// explicit status update it would sit in `Pending` indefinitely
												// (no wallet pointer → invisible to wallet-timeouts; no request
												// pointer → invisible to tx-sync), accumulating as DB pollution.
												status: TransactionStatus.RolledBack,
											},
										});
										for (const v of fit) {
											// Reconnect to the pre-batch CurrentTransaction only if that
											// prior Tx is still in an active state (Pending / Confirmed).
											// If the prior Tx was itself a rolled-back / failed batch
											// (e.g. this request has cycled through multiple failed
											// batches), re-connecting would point the request at a dead
											// Tx — leaving wallet-timeouts and tx-sync to wade through
											// stale pointers. Disconnecting in that case mirrors the
											// "no pre-batch active tx" branch and lets the next scheduler
											// tick pick the request up cleanly.
											let shouldReconnect = false;
											if (v.request.currentTransactionId != null) {
												const priorTx = await tx.transaction.findUnique({
													where: { id: v.request.currentTransactionId },
													select: { status: true },
												});
												shouldReconnect =
													priorTx != null &&
													(priorTx.status === TransactionStatus.Pending ||
														priorTx.status === TransactionStatus.Confirmed);
											}
											await tx.registryRequest.update({
												where: { id: v.request.id },
												data: {
													state: RegistrationState.DeregistrationRequested,
													CurrentTransaction:
														shouldReconnect && v.request.currentTransactionId != null
															? { connect: { id: v.request.currentTransactionId } }
															: { disconnect: true },
												},
											});
										}
									},
									{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
								),
							{ label: 'v2-deregister-batch-tx' },
						);
					} catch (rollbackError) {
						logger.error('V2 deregister batch rollback after submit failure failed; skipping single-item fallback', {
							sharedTxId,
							requestIds: fit.map((v) => v.request.id),
							submitError:
								submitError instanceof Error
									? { message: submitError.message, stack: submitError.stack, name: submitError.name }
									: submitError,
							rollbackError:
								rollbackError instanceof Error
									? { message: rollbackError.message, stack: rollbackError.stack, name: rollbackError.name }
									: rollbackError,
						});
						return;
					}
					await fallbackToSingleItems(fit, paymentSource, network, script, policyId);
					// Rollback only cleared pendingTransactionId; lockedAt stays set. Conditional
					// unlock prevents the wallet from orphan-locking when every single-item fallback
					// deferred — preserves the lock when a single-item submit succeeded.
					await unlockHotWalletIfNoPendingTransaction(deregistrationWallet.id, 'v2-deregister-batch-rollback');
					return;
				}

				try {
					await walletSession.evaluateProjectedBalance(unsignedTx, walletUtxos);
				} catch (balanceError) {
					logger.warn('V2 deregister batch projected balance evaluation failed (non-fatal)', {
						error:
							balanceError instanceof Error
								? { message: balanceError.message, stack: balanceError.stack, name: balanceError.name }
								: balanceError,
					});
				}

				// Post-submit: a SINGLE Transaction row carries the txHash for
				// the whole batch (pre-submit created one shared Tx referenced
				// by every fit item). One update suffices.
				try {
					await retryOnSerializationConflict(
						() =>
							prisma.$transaction(
								async (tx) => {
									await tx.transaction.update({
										where: { id: sharedTxId },
										data: { txHash: newTxHash },
									});
								},
								{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
							),
						{ label: 'v2-deregister-batch-tx' },
					);
				} catch (dbError) {
					logger.error('V2 deregister batch post-submit DB update failed; tx-sync will reconcile next tick', {
						error:
							dbError instanceof Error
								? { message: dbError.message, stack: dbError.stack, name: dbError.name }
								: dbError,
						txHash: newTxHash,
					});
				}

				logger.debug(`Created V2 deregister batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
			}),
		);
	} catch (error) {
		logger.error('Error deregistering V2 agents', { error });
	} finally {
		release?.();
	}
}

async function fallbackToSingleItems(
	validated: ValidatedDeregistrationItem[],
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
	policyId: string,
): Promise<void> {
	// Process AT MOST ONE item, not all N. Submitting the first item
	// creates a PendingTransaction that locks the hot wallet, so any
	// subsequent item in this tick would just race the wallet lock and
	// fail. The remaining items stay in their queued state — next
	// scheduler tick (after tx-sync clears the lock) re-picks them up
	// and batches them again. The fallback exists purely so a single
	// bad item (invalid datum, asset UTxO missing, etc.) does not block
	// the rest forever; it is NOT a parallel retry path. In the happy
	// path the batch builder above handles everything in one tx and
	// this function never runs.
	if (validated.length === 0) return;
	const v = validated[0];
	try {
		await advancedRetry({
			errorResolvers: [delayErrorResolver({ configuration: SERVICE_CONSTANTS.RETRY })],
			operation: async () => {
				await processSingleDeregistration(v, paymentSource, network, script, policyId);
				return true;
			},
		});
	} catch (error) {
		await markRequestFailed(v.request, error);
	}
	// validated[1..] intentionally left untouched — they remain in
	// their `*Requested` state and the next tick (after the wallet
	// unlocks) will batch them again. Do NOT mark them failed: a batch
	// build failure caused by a transient issue (network blip,
	// cost-model sync race) is not a per-item failure and the items
	// deserve another chance.
}
