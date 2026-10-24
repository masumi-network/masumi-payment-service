import { buildAgentMetadata, validateRegistrationPricing } from './metadata';
import { PaymentSourceType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@masumi/payment-core/blockchain-error-interpreter';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';
import {
	connectExistingTransaction,
	createMeshProvider,
	disconnectTransactionWallet,
	loadHotWalletSession,
} from '@/services/shared';
import {
	generateRegistryAssetNameV2,
	registryNonceForIndex,
	resolveRegistryFundingLovelace,
	resolveRegistryRecipientWalletAddress,
	V2_REGISTRY_MAX_MINTS_PER_UTXO,
} from '@/services/registry/shared';
import { pickBatchCollateral, shrinkBatchToFit } from '../../../builders/batch-helpers';
import { type BatchRegistryMintItem, generateRegistryBatchMintTransaction } from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordRegistryPrepFailure,
	resetRegistryPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { asV2Provider } from '../../provider-cast';
import { buildSignedRegistryMintPrefix } from './signed-batch';

// V2 registry batch sizing. The on-chain `MintAction` validator runs once for
// the policy bucket and verifies every minted asset name against the set of
// spent inputs, so the per-item cost is mostly off-chain (CIP-25 metadata + a
// fresh wallet UTxO per asset). The cap balances tx-size headroom against
// scheduler throughput.
//
// Held at 5 (not 7): every item's CIP-25 metadata lands in ONE combined `721`
// block (see batch-registry.ts), and per-agent metadata can be large once
// verification claims, example outputs, and multiple payment sources are
// folded in (see buildAgentMetadata). At 7 a fully-populated batch routinely
// overran the available transaction size. The signed-size shrink below is the guard;
// this cap just keeps the common case from wasting build passes on a batch
// that will always shrink.
const REGISTRY_BATCH_SIZE = 5;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

type ValidatedRegistryItem = {
	request: RegistryRequestRecord;
	item: BatchRegistryMintItem;
	assetName: string;
	policyId: string;
};

async function markRequestFailed(
	request: RegistryRequestRecord,
	error: unknown,
	options: { unlockWallet?: boolean } = {},
): Promise<void> {
	// unlockWallet=true when this failure frees the wallet (single-item terminal
	// path, or markBatchFailed where the whole batch failed). In the per-item
	// validation loop the shared wallet lock must survive so a concurrent service
	// can't grab the wallet and submit a conflicting mint from the same UTxO set
	// while the batch keeps building the remaining validated items; the batch's
	// terminal paths (all-failed unlock, submit success, markBatchFailed) free it.
	const unlockWallet = options.unlockWallet ?? true;
	logger.error(`Error registering V2 agent ${request.id}`, { error });
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.RegistrationFailed,
			error: interpretBlockchainError(error),
			...(unlockWallet ? { SmartContractWallet: { update: { lockedAt: null } } } : {}),
		},
	});
}

/**
 * Fail every request in an attempted batch. Used when the batch transaction
 * cannot be built or signed.
 *
 * By the time the batch builder runs, per-item validation has already passed
 * (bad items are marked failed individually in the validation loop), and the
 * size-aware shrink has already dropped any items that don't fit. So a
 * build/sign failure here is a SHARED-cause failure — collateral, evaluateTx,
 * cost-model, or a node-side rejection — that affects every item in the batch
 * equally. We deliberately do NOT retry one-at-a-time: that only masked the
 * real error as slow-but-working (and made registrations look sequential).
 * Failing the batch hard surfaces the actual cause. `markRequestFailed` also
 * clears the shared wallet lock (idempotent across the batch).
 */
async function markBatchFailed(fit: ValidatedRegistryItem[], error: unknown): Promise<void> {
	await Promise.allSettled(fit.map((v) => markRequestFailed(v.request, error)));
}

/**
 * Release the hot wallet lock acquired by `lockAndQueryRegistryRequests` when
 * the batch path bails early without making forward progress. Idempotent —
 * downstream tx-sync also clears `lockedAt` on confirmation/failure.
 */
async function unlockHotWallet(hotWalletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: hotWalletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to release hot wallet lock after V2 register batch bail-out', {
			hotWalletId,
			error,
		});
	}
}

/**
 * Per-request validation pass. Returns a `ValidatedRegistryItem` if the
 * request passed every check; throws otherwise (caller maps thrown errors to
 * RegistrationFailed). The thrown branch is intentional — it mirrors the
 * V1-style per-item failure model so caller code stays uniform.
 */
function validateAndBuildItem(
	request: RegistryRequestRecord,
	utxo: UTxO,
	policyId: string,
	nonce: string,
): ValidatedRegistryItem {
	validateRegistrationPricing(request);
	const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
	const fundingLovelace = resolveRegistryFundingLovelace(request);
	// V2 mint contract requires the structured asset name
	// [1B nonce>0x0f | 28B blake2b_224 | 3B version 0x000000] — the V1 flat
	// blake2b_256 layout would fail every check. The whole batch shares one
	// `utxo` (oneshot) and disambiguates via a distinct `nonce` per item.
	const assetName = generateRegistryAssetNameV2(utxo, nonce);
	const metadata = buildAgentMetadata(request);
	return {
		request,
		assetName,
		policyId,
		item: {
			recipientWalletAddress,
			fundingLovelace,
			assetName,
			firstUtxo: utxo,
			metadata,
		},
	};
}

export async function registerAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('registry_register_v2 is already running, skipping cycle');
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryRegistryRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: REGISTRY_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.RegistryRequest.length === 0) return;
				// Wallet shared by this batch; lockAndQueryRegistryRequests already set its
				// `lockedAt`. The catch below releases it on any unexpected throw before a tx
				// is submitted, so a throw (createMeshProvider, script derivation,
				// ensureCollateralReady, …) can't leave the wallet locked forever — no reaper
				// frees a lock that carries no pending transaction.
				const lockedWalletId = paymentSource.RegistryRequest[0].SmartContractWallet.id;
				try {
					logger.info(
						`Registering ${paymentSource.RegistryRequest.length} V2 agents for payment source ${paymentSource.id}`,
					);
					const network = convertNetwork(paymentSource.network);
					const registryRequests = paymentSource.RegistryRequest;
					if (registryRequests.length === 0) return;

					// lockAndQueryRegistryRequests guarantees every request in this
					// batch shares the same SmartContractWallet, so a single wallet
					// session and one UTxO set drive the whole batch.
					const firstRequest = registryRequests[0];
					const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
					const rpcApiKey = paymentSource.PaymentSourceConfig.rpcProviderApiKey;
					const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

					let walletSession;
					try {
						walletSession = await loadHotWalletSession({
							network: paymentSource.network,
							rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
							encryptedMnemonic: firstRequest.SmartContractWallet.Secret.encryptedMnemonic,
							hotWalletId: firstRequest.SmartContractWallet.id,
						});
					} catch (error) {
						logger.warn(
							'V2 register batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
							{
								error:
									error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
								batchSize: registryRequests.length,
							},
						);
						// Wallet-load failure is NOT a per-item failure: every
						// request was waiting on the same wallet. Unlock and
						// leave the items queued; next tick re-batches them.
						await unlockHotWallet(firstRequest.SmartContractWallet.id);
						return;
					}
					const { wallet, utxos, address } = walletSession;
					if (utxos.length === 0) {
						logger.warn(
							'V2 register batch hot wallet has no UTxOs; leaving items in pool for next tick [batch-fallback]',
							{
								batchSize: registryRequests.length,
							},
						);
						// Empty wallet — transient operational state. Leave
						// items queued; next tick after wallet has UTxOs
						// re-batches them.
						await unlockHotWallet(firstRequest.SmartContractWallet.id);
						return;
					}

					const collateralCheck = await ensureCollateralReady({
						walletDbId: firstRequest.SmartContractWallet.id,
						walletAddress: address,
						meshWallet: wallet,
						utxos,
						blockchainProvider,
						network,
						serviceLabel: 'registry-register-batch',
					});
					if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
						// Wallet cannot fund collateral for the whole batch (all items share
						// this wallet). Fail every item with a clear reason instead of
						// silently deferring forever, so they land in RegistrationFailed, are
						// visible, and can be recreated once the wallet is funded.
						const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the wallet with ADA and retry.`;
						await Promise.allSettled(
							registryRequests.map((request) => markRequestFailed(request, new Error(failureMessage))),
						);
						return;
					}
					if (collateralCheck.status === 'failed') {
						// reason === 'prep_tx_failed' (transient; wallet already unlocked).
						// Bound per-request retries so a deterministically-failing prep
						// surfaces as RegistrationFailed instead of looping forever.
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

					// Pick collateral FIRST (smallest qualifying UTxO >= 5 ADA) so the
					// remaining sorted-by-lovelace pool can drive distinct
					// per-item `firstUtxo`s without overlap.
					//
					// Pure ADA is PREFERRED, not required: Babbage/CIP-40 permits
					// token-bearing collateral, and the builder's
					// `setTotalCollateral` makes Mesh emit the `collateral_return`
					// output that hands the balance back. A previous version of
					// this comment claimed Conway rejects any non-ADA collateral
					// and that we never fall back — neither was true of the
					// selector. If NO UTxO clears the 5 ADA floor we defer to the
					// next tick, when the wallet may have more UTxOs.
					const collateralUtxo = pickBatchCollateral(utxos, []);
					if (collateralUtxo == null) {
						logger.warn(
							'V2 register batch: no wallet UTxO has enough lovelace to serve as collateral (>=5 ADA); deferring to next tick',
						);
						await unlockHotWallet(firstRequest.SmartContractWallet.id);
						return;
					}

					// Oneshot rule: the V2 mint validator derives each asset's 28-byte
					// root from `blake2b_224(firstUtxo)` and verifies that root against
					// the spent inputs — it does NOT constrain the 1-byte nonce. So ONE
					// consumed input can authorize the whole batch: every item shares a
					// single `firstUtxo` and is disambiguated by a distinct nonce
					// (0x10, 0x11, …). This means even a 1-UTxO wallet can register a
					// full batch (the prior code wrongly demanded one wallet UTxO per
					// agent). We pick the largest UTxO as the shared firstUtxo; the
					// builder de-dupes it down to a single txIn, and Conway phase-1
					// permits it to double as collateral, so no extra UTxO is needed.
					const spendableUtxos = sortUtxosByLovelaceDesc(utxos);
					const sharedFirstUtxo = spendableUtxos[0];

					// The nonce range caps mints-per-input at 240. REGISTRY_BATCH_SIZE is
					// far below that, but guard anyway: process at most that many this
					// tick and leave any overflow in RegistrationRequested for the next.
					const mintableRequests = registryRequests.slice(0, V2_REGISTRY_MAX_MINTS_PER_UTXO);
					if (registryRequests.length > mintableRequests.length) {
						logger.warn(
							`V2 register batch of ${registryRequests.length} exceeds ${V2_REGISTRY_MAX_MINTS_PER_UTXO} mints/UTxO; deferring ${registryRequests.length - mintableRequests.length} to next tick`,
						);
					}

					// Validate every request in parallel. The async callback turns any
					// synchronous throw (pricing validation, asset-name build) into a
					// settled 'rejected' outcome so a single bad item can't escape
					// Promise.allSettled and abort the whole batch via the outer catch.
					const validations = await Promise.allSettled(
						mintableRequests.map(async (request, idx) =>
							validateAndBuildItem(request, sharedFirstUtxo, policyId, registryNonceForIndex(idx)),
						),
					);

					const validated: ValidatedRegistryItem[] = [];
					for (let idx = 0; idx < validations.length; idx++) {
						const outcome = validations[idx];
						const request = mintableRequests[idx];
						if (outcome.status === 'fulfilled') {
							validated.push(outcome.value);
						} else {
							// Mid-batch: keep the shared wallet lock (see markRequestFailed).
							await markRequestFailed(request, outcome.reason, { unlockWallet: false });
						}
					}

					if (validated.length === 0) {
						logger.info('No V2 register requests passed validation this tick');
						await unlockHotWallet(firstRequest.SmartContractWallet.id);
						return;
					}

					// Prepare the candidate batch. The signed-size loop below shrinks it
					// if needed. The mint path permits `firstUtxo == collateral`:
					// Mesh puts the ref in both body fields and dedupes collateral
					// during assembly. A separate collateral requirement would block
					// wallets with one UTxO. The loop checks the live L1 size limit.
					const shrinkResult = shrinkBatchToFit(validated, () => ({ ok: true }));

					if (shrinkResult.fit.length === 0) {
						logger.error('V2 register batch could not satisfy collateral non-overlap invariant', {
							reason: shrinkResult.reason,
						});
						await unlockHotWallet(firstRequest.SmartContractWallet.id);
						return;
					}
					if (shrinkResult.dropped.length > 0) {
						logger.warn(
							`V2 register batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason}); dropped items will retry next tick`,
						);
					}

					// Build, evaluate, and sign the largest prefix that fits the current
					// L1 protocol limit. Dropped items stay queued for the next tick.
					let fit = shrinkResult.fit;
					let unsignedTx: string;
					let signedTx: string;
					try {
						const protocolParameters =
							getCachedChainProtocolParameters(rpcApiKey) ??
							(await blockchainProvider.fetchProtocolParameters(Number.NaN));
						const buildMintTx = (subsetItems: BatchRegistryMintItem[], mintBudget?: { mem: number; steps: number }) =>
							generateRegistryBatchMintTransaction(
								asV2Provider(blockchainProvider),
								network,
								script,
								address,
								policyId,
								subsetItems,
								collateralUtxo,
								spendableUtxos,
								mintBudget,
								rpcApiKey,
							);
						const sized = await buildSignedRegistryMintPrefix(
							fit.map((v) => v.item),
							protocolParameters,
							(subsetItems) => buildMintTx(subsetItems),
							async (evaluationTx) =>
								(await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
									tag?: string;
									budget: { mem: number; steps: number };
								}>,
							(subsetItems, mintBudget) => buildMintTx(subsetItems, mintBudget),
							(tx) => wallet.signTx(tx, true),
						);
						if (sized == null) {
							// The first item alone exceeds the protocol size limit.
							// Fail it so later requests can proceed on the next tick.
							logger.error('V2 register batch: a single item exceeds the tx-size limit; marking it failed', {
								requestId: fit[0].request.id,
							});
							await markRequestFailed(
								fit[0].request,
								new Error('Agent metadata is too large to mint within the transaction size limit'),
							);
							return;
						}
						if (sized.fitCount < fit.length) {
							logger.warn(
								`V2 register batch shrunk from ${fit.length} to ${sized.fitCount} for signed tx-size; deferring ${fit.length - sized.fitCount} to next tick`,
							);
						}
						fit = fit.slice(0, sized.fitCount);
						unsignedTx = sized.unsignedTx;
						signedTx = sized.signedTx;
					} catch (batchError) {
						logger.error('V2 register batch build or sign failed; marking batch failed', {
							error:
								batchError instanceof Error
									? { message: batchError.message, stack: batchError.stack, name: batchError.name }
									: batchError,
							batchSize: fit.length,
						});
						await markBatchFailed(fit, batchError);
						return;
					}

					// Pre-submit DB transition: create ONE shared Transaction row
					// carrying BlocksWallet → wallet, then connect every fit item's
					// CurrentTransaction to that shared Tx. Replaces the N-orphan
					// pattern — HotWallet.pendingTransactionId points to the single
					// shared Tx, so tx-sync's BlocksWallet-driven wallet unlock
					// fires exactly once per batch.
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
												BlocksWallet: { connect: { id: firstRequest.SmartContractWallet.id } },
											},
										});
										for (const v of fit) {
											await tx.registryRequest.update({
												where: { id: v.request.id },
												data: {
													state: RegistrationState.RegistrationInitiated,
													...connectExistingTransaction(sharedTx.id),
												},
											});
										}
										return sharedTx.id;
									},
									{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
								),
							{ label: 'v2-register-batch-tx' },
						);
					} catch (dbError) {
						logger.error('V2 register batch DB pre-submit update failed', { error: dbError });
						await unlockHotWallet(firstRequest.SmartContractWallet.id);
						return;
					}

					let newTxHash: string;
					try {
						newTxHash = await wallet.submitTx(signedTx);
					} catch (submitError) {
						logger.error('V2 register batch submit failed; marking batch failed', {
							error:
								submitError instanceof Error
									? { message: submitError.message, stack: submitError.stack, name: submitError.name }
									: submitError,
							batchSize: fit.length,
						});
						// A submit rejection is a shared-cause failure (collateral / phase-1 /
						// script-data-hash) that affects the whole batch — there is no
						// single-item retry. Roll back the orphan shared Transaction (mark
						// RolledBack + drop its wallet pointer so it isn't left Pending
						// forever) and fail every participating request, clearing the wallet
						// lock so the next tick is free.
						try {
							await retryOnSerializationConflict(
								() =>
									prisma.$transaction(
										async (tx) => {
											await tx.transaction.update({
												where: { id: sharedTxId },
												data: {
													...disconnectTransactionWallet(),
													status: TransactionStatus.RolledBack,
												},
											});
											for (const v of fit) {
												await tx.registryRequest.update({
													where: { id: v.request.id },
													data: {
														state: RegistrationState.RegistrationFailed,
														error: interpretBlockchainError(submitError),
														CurrentTransaction: { disconnect: true },
														SmartContractWallet: { update: { lockedAt: null } },
													},
												});
											}
										},
										{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
									),
								{ label: 'v2-register-batch-tx' },
							);
						} catch (rollbackError) {
							logger.error(
								'V2 register batch fail-mark after submit failure failed; wallet may stay locked until tx-sync',
								{
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
								},
							);
							// Best-effort unlock so a failed DB write doesn't orphan-lock the wallet.
							await unlockHotWalletIfNoPendingTransaction(
								firstRequest.SmartContractWallet.id,
								'v2-register-batch-rollback',
							);
						}
						return;
					}

					try {
						await walletSession.evaluateProjectedBalance(unsignedTx, spendableUtxos);
					} catch (balanceError) {
						logger.warn('V2 register batch projected balance evaluation failed (non-fatal)', { error: balanceError });
					}

					// Post-submit: write the txHash to the SHARED Transaction row
					// (a single update covers every participating request) and
					// stamp each item's per-request agentIdentifier.
					try {
						await retryOnSerializationConflict(
							() =>
								prisma.$transaction(
									async (tx) => {
										await tx.transaction.update({
											where: { id: sharedTxId },
											data: { txHash: newTxHash },
										});
										for (const v of fit) {
											await tx.registryRequest.update({
												where: { id: v.request.id },
												data: {
													agentIdentifier: v.policyId + v.assetName,
												},
											});
										}
									},
									{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
								),
							{ label: 'v2-register-batch-tx' },
						);
					} catch (dbError) {
						logger.error('V2 register batch post-submit DB update failed; rows will reconcile via tx-sync next tick', {
							error:
								dbError instanceof Error
									? { message: dbError.message, stack: dbError.stack, name: dbError.name }
									: dbError,
							txHash: newTxHash,
						});
					}

					logger.debug(`Created V2 register batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
				} catch (unexpectedError) {
					logger.error('V2 register batch threw unexpectedly; releasing wallet lock [batch-fallback]', {
						paymentSourceId: paymentSource.id,
						hotWalletId: lockedWalletId,
						error:
							unexpectedError instanceof Error
								? { message: unexpectedError.message, stack: unexpectedError.stack, name: unexpectedError.name }
								: unexpectedError,
					});
					// Guarded: clears lockedAt only when no pending tx is attached, so a
					// wallet that already submitted a (prep/mint) tx is left for tx-sync.
					await unlockHotWalletIfNoPendingTransaction(lockedWalletId, 'registry-register-batch');
				}
			}),
		);
	} catch (error) {
		logger.error('Error registering V2 agents', { error });
	} finally {
		release?.();
	}
}
