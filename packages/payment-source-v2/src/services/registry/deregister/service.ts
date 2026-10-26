import { PaymentSourceType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { UTxO } from '@meshsdk/core';
import { asV2Provider } from '../../provider-cast';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { extractAssetName } from '@/utils/converter/agent-identifier';
import {
	connectExistingTransaction,
	createMeshProvider,
	disconnectTransactionWallet,
	loadHotWalletSession,
} from '@/services/shared';
import { findRegistryTokenUtxo, resolveRegistryDeregistrationWallet } from '@/services/registry/shared';
import {
	assertNoCollateralOverlap,
	assertSignedL1TxSizeWithinProtocolLimit,
	pickBatchCollateral,
	shrinkBatchToFit,
} from '../../../builders/batch-helpers';
import { generateRegistryBatchDeregisterTransactionAutomaticFees } from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordRegistryPrepFailure,
	resetRegistryPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { fallbackToSingleItems, markRequestFailed, unlockHotWallet } from './single';
import type { RegistryRequestRecord, ValidatedDeregistrationItem } from './single';

// V2 registry deregister sizing. Burn legs all share one BurnAction redeemer,
// so per-item cost is dominated by tx-size (each burn pulls in the asset's
// UTxO and emits no continuation output). The cap matches the register side.
const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

function validateDeregistrationRequest(request: { agentIdentifier: string | null }): void {
	if (!request.agentIdentifier) {
		throw new Error('Agent identifier is not set');
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

export async function deRegisterAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('registry_deregister_v2 is already running, skipping cycle');
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
					// Deferred prep owns the wallet via PendingTransaction; release the
					// batch lock so the deregister worker can resume after prep confirms.
					await unlockHotWallet(deregistrationWallet.id);
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

				// Check collateral overlap before building. The complete signed
				// transaction size is checked after signing.
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
					const protocolParameters =
						getCachedChainProtocolParameters(paymentSource.PaymentSourceConfig.rpcProviderApiKey) ??
						(await blockchainProvider.fetchProtocolParameters(Number.NaN));
					assertSignedL1TxSizeWithinProtocolLimit(signedTx, protocolParameters, 'v2-registry-batch-deregister');
				} catch (signError) {
					logger.warn(
						'V2 deregister batch sign or size check failed; falling back to single-item processing [batch-fallback]',
						{
							error:
								signError instanceof Error
									? { message: signError.message, stack: signError.stack, name: signError.name }
									: signError,
						},
					);
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
