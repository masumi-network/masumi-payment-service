import { PaymentSourceType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryInboxAgentRegistrationRequests } from '@/utils/db/lock-and-query-inbox-agent-registration-request';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { DEFAULTS } from '@masumi/payment-core/config';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { getCachedChainProtocolParameters } from '@/utils/mesh-cost-model-sync';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
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
import {
	assertSignedL1TxSizeWithinProtocolLimit,
	pickBatchCollateral,
	shrinkBatchToFit,
} from '../../../builders/batch-helpers';
import { generateRegistryBatchMintTransaction } from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordInboxPrepFailure,
	resetInboxPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { asV2Provider } from '../../provider-cast';
import { buildInboxAgentMetadata } from '../metadata';
import { fallbackToSingleItems, markRequestFailed, unlockHotWallet } from './single';
import type { InboxRequestRecord, ValidatedInboxItem } from './single';

// Mirrors the V2 registry register cap. Inbox-agent items carry far less
// metadata than full agent registrations, so the tx-size pressure is lower
// and we could push higher; staying at 7 keeps the two paths uniform and
// usually below the signed L1 maxTxSize limit.
const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

function validateAndBuildItem(
	request: InboxRequestRecord,
	utxo: UTxO,
	policyId: string,
	nonce: string,
): ValidatedInboxItem {
	const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
	const fundingLovelace = resolveRegistryFundingLovelace(request);
	// Oneshot: the whole batch shares one `utxo`; a distinct `nonce` per item
	// keeps every asset name unique (see registry/shared.ts).
	const assetName = generateRegistryAssetNameV2(utxo, nonce);
	const metadata = buildInboxAgentMetadata({
		name: request.name,
		description: request.description,
		agentSlug: request.agentSlug,
		metadataVersion: request.metadataVersion ?? DEFAULTS.DEFAULT_METADATA_VERSION,
	});
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

export async function registerInboxAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch {
		logger.info('registry_inbox_register_v2 is already running, skipping cycle');
		return;
	}

	try {
		const paymentSourcesWithWalletLocked = await lockAndQueryInboxAgentRegistrationRequests({
			state: RegistrationState.RegistrationRequested,
			maxBatchSize: REGISTRY_BATCH_SIZE,
			paymentSourceType: PaymentSourceType.Web3CardanoV2,
		});

		await Promise.allSettled(
			paymentSourcesWithWalletLocked.map(async (paymentSource) => {
				if (paymentSource.InboxAgentRegistrationRequests.length === 0) return;

				logger.info(
					`Registering ${paymentSource.InboxAgentRegistrationRequests.length} V2 inbox agents for payment source ${paymentSource.id}`,
				);

				const network = convertNetwork(paymentSource.network);
				const registrationRequests = paymentSource.InboxAgentRegistrationRequests;
				if (registrationRequests.length === 0) return;

				const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
				const rpcApiKey = paymentSource.PaymentSourceConfig.rpcProviderApiKey;
				const { script, policyId } = await getRegistryScriptFromNetworkHandlerV2(paymentSource);

				const firstRequest = registrationRequests[0];

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
						'V2 inbox register batch could not load wallet session; leaving items in pool for next tick [batch-fallback]',
						{
							error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
							batchSize: registrationRequests.length,
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
						'V2 inbox register batch hot wallet has no UTxOs; leaving items in pool for next tick [batch-fallback]',
						{
							batchSize: registrationRequests.length,
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
					serviceLabel: 'inbox-register-batch',
				});
				if (collateralCheck.status === 'failed' && collateralCheck.reason === 'insufficient_funds') {
					// Wallet cannot fund collateral for the whole batch (all items share
					// this wallet). Fail every item with a clear reason instead of
					// silently deferring forever, so they land in RegistrationFailed,
					// are visible, and can be retried once the wallet is funded
					// (recreate the inbox registration).
					const failureMessage = `Wallet balance too low to fund the collateral preparation transaction: ${collateralCheck.details}. Top up the wallet with ADA and retry.`;
					await Promise.allSettled(
						registrationRequests.map((request) => markRequestFailed(request, new Error(failureMessage))),
					);
					return;
				}
				if (collateralCheck.status === 'failed') {
					// reason === 'prep_tx_failed' (transient; wallet already unlocked).
					// Bound per-request retries so a deterministically-failing prep
					// surfaces as RegistrationFailed instead of looping forever.
					await Promise.allSettled(
						registrationRequests.map(async (request) => {
							const reachedLimit = await recordInboxPrepFailure(request.id);
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
				await Promise.allSettled(registrationRequests.map((request) => resetInboxPrepFailureCount(request.id)));

				const collateralUtxo = pickBatchCollateral(utxos, []);
				if (collateralUtxo == null) {
					logger.warn(
						'V2 inbox register batch: no wallet UTxO has enough lovelace to serve as collateral (>=5 ADA); deferring to next tick',
					);
					await unlockHotWallet(firstRequest.SmartContractWallet.id);
					return;
				}

				// MINT-only tx: Conway phase-1 does NOT forbid the collateral UTxO
				// from also appearing in the (non-script) spending input set.
				// Mesh-SDK routes `.txIn(...)` and `.txInCollateral(...)` into
				// separate body fields. Allow `firstUtxo[0]` to be the same UTxO
				// as the collateral so a 1-UTxO wallet can still drive a 1-item
				// batch — matches the V1 single-tx register pattern.
				// Oneshot rule: the V2 mint validator derives each asset's 28-byte
				// root from blake2b_224(firstUtxo) and checks it against the spent
				// inputs, ignoring the 1-byte nonce. So ONE consumed input authorizes
				// the whole batch — every item shares a single firstUtxo and is
				// disambiguated by a distinct nonce. A 1-UTxO wallet can drive a full
				// batch (Conway phase-1 lets that UTxO double as collateral too).
				const spendableUtxos = sortUtxosByLovelaceDesc(utxos);
				const sharedFirstUtxo = spendableUtxos[0];

				// Nonce range caps mints-per-input at 240; REGISTRY_BATCH_SIZE is far
				// below that. Guard anyway: defer any overflow to the next tick.
				const mintableRequests = registrationRequests.slice(0, V2_REGISTRY_MAX_MINTS_PER_UTXO);
				if (registrationRequests.length > mintableRequests.length) {
					logger.warn(
						`V2 inbox register batch of ${registrationRequests.length} exceeds ${V2_REGISTRY_MAX_MINTS_PER_UTXO} mints/UTxO; deferring ${registrationRequests.length - mintableRequests.length} to next tick`,
					);
				}

				// Async callback so any synchronous throw becomes a settled
				// 'rejected' outcome instead of escaping Promise.allSettled.
				const validations = await Promise.allSettled(
					mintableRequests.map(async (request, idx) =>
						validateAndBuildItem(request, sharedFirstUtxo, policyId, registryNonceForIndex(idx)),
					),
				);

				const validated: ValidatedInboxItem[] = [];
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
					logger.info('No V2 inbox register requests passed validation this tick');
					await unlockHotWallet(firstRequest.SmartContractWallet.id);
					return;
				}

				// No-collateral-overlap is NOT a hard invariant here — mint-only
				// txs tolerate `firstUtxo == collateral` (see the matching
				// comment in services/registry/register/service.ts). Tx-size is
				// validated inline after the build pass.
				const shrinkResult = shrinkBatchToFit(validated, () => ({ ok: true }));

				if (shrinkResult.fit.length === 0) {
					logger.error('V2 inbox register batch could not satisfy collateral non-overlap invariant', {
						reason: shrinkResult.reason,
					});
					await unlockHotWallet(firstRequest.SmartContractWallet.id);
					return;
				}
				if (shrinkResult.dropped.length > 0) {
					logger.warn(
						`V2 inbox register batch shrunk from ${validated.length} to ${shrinkResult.fit.length} (reason=${shrinkResult.reason})`,
					);
				}

				const fit = shrinkResult.fit;
				const items = fit.map((v) => v.item);

				let unsignedTx: string;
				try {
					const evaluationTx = await generateRegistryBatchMintTransaction(
						asV2Provider(blockchainProvider),
						network,
						script,
						address,
						policyId,
						items,
						collateralUtxo,
						spendableUtxos,
						undefined,
						rpcApiKey,
					);
					const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
						tag?: string;
						budget: { mem: number; steps: number };
					}>;
					const mintBudget = estimatedFee.find((action) => action.tag === 'MINT')?.budget ?? estimatedFee[0]?.budget;
					if (mintBudget == null) {
						throw new Error('evaluateTx returned no MINT budget for V2 inbox register batch');
					}
					unsignedTx = await generateRegistryBatchMintTransaction(
						asV2Provider(blockchainProvider),
						network,
						script,
						address,
						policyId,
						items,
						collateralUtxo,
						spendableUtxos,
						mintBudget,
						rpcApiKey,
					);
				} catch (batchError) {
					logger.warn('V2 inbox register batch build failed; falling back to single-item processing [batch-fallback]', {
						error:
							batchError instanceof Error
								? { message: batchError.message, stack: batchError.stack, name: batchError.name }
								: batchError,
						batchSize: fit.length,
					});
					await fallbackToSingleItems(fit, paymentSource, network, script);
					return;
				}

				let signedTx: string;
				try {
					signedTx = await wallet.signTx(unsignedTx, true);
					const protocolParameters =
						getCachedChainProtocolParameters(rpcApiKey) ??
						(await blockchainProvider.fetchProtocolParameters(Number.NaN));
					assertSignedL1TxSizeWithinProtocolLimit(signedTx, protocolParameters, 'v2-inbox-batch-mint');
				} catch (signError) {
					logger.warn(
						'V2 inbox register batch sign or size check failed; falling back to single-item processing [batch-fallback]',
						{
							error:
								signError instanceof Error
									? { message: signError.message, stack: signError.stack, name: signError.name }
									: signError,
						},
					);
					await fallbackToSingleItems(fit, paymentSource, network, script);
					return;
				}

				// Pre-submit: create ONE shared Transaction row carrying
				// BlocksWallet → wallet, then connect every fit item's
				// CurrentTransaction to that shared Tx so tx-sync's
				// BlocksWallet-driven wallet unlock fires once per batch.
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
										await tx.inboxAgentRegistrationRequest.update({
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
						{ label: 'v2-inbox-register-batch-tx' },
					);
				} catch (dbError) {
					logger.error('V2 inbox register batch DB pre-submit update failed', { error: dbError });
					await unlockHotWallet(firstRequest.SmartContractWallet.id);
					return;
				}

				let newTxHash: string;
				try {
					newTxHash = await wallet.submitTx(signedTx);
				} catch (submitError) {
					logger.warn('V2 inbox register batch submit failed; rolling back DB and retrying as single items', {
						error:
							submitError instanceof Error
								? { message: submitError.message, stack: submitError.stack, name: submitError.name }
								: submitError,
					});
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
										await tx.inboxAgentRegistrationRequest.update({
											where: { id: v.request.id },
											data: {
												state: RegistrationState.RegistrationRequested,
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
						{ label: 'v2-inbox-register-batch-tx' },
					);
					await fallbackToSingleItems(fit, paymentSource, network, script);
					// Rollback only cleared pendingTransactionId; lockedAt stays set. Conditional
					// unlock prevents the wallet from orphan-locking when every single-item fallback
					// deferred — preserves the lock when a single-item submit succeeded.
					await unlockHotWalletIfNoPendingTransaction(
						firstRequest.SmartContractWallet.id,
						'v2-inbox-register-batch-rollback',
					);
					return;
				}

				try {
					await walletSession.evaluateProjectedBalance(unsignedTx, spendableUtxos);
				} catch (balanceError) {
					logger.warn('V2 inbox register batch projected balance evaluation failed (non-fatal)', {
						error:
							balanceError instanceof Error
								? { message: balanceError.message, stack: balanceError.stack, name: balanceError.name }
								: balanceError,
					});
				}

				// Post-submit: write the txHash to the SHARED Transaction row
				// and stamp each item's per-request agentIdentifier.
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
										await tx.inboxAgentRegistrationRequest.update({
											where: { id: v.request.id },
											data: {
												agentIdentifier: v.policyId + v.assetName,
											},
										});
									}
								},
								{ isolationLevel: 'Serializable', timeout: 30_000, maxWait: 30_000 },
							),
						{ label: 'v2-inbox-register-batch-tx' },
					);
				} catch (dbError) {
					logger.error('V2 inbox register batch post-submit DB update failed; tx-sync will reconcile next tick', {
						error:
							dbError instanceof Error
								? { message: dbError.message, stack: dbError.stack, name: dbError.name }
								: dbError,
						txHash: newTxHash,
					});
				}

				logger.debug(`Created V2 inbox agent registration batch transaction:
              Tx ID: ${newTxHash}
              Items: ${fit.length}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
			}),
		);
	} catch (error) {
		logger.error('Error registering V2 inbox agents', { error });
	} finally {
		release?.();
	}
}
