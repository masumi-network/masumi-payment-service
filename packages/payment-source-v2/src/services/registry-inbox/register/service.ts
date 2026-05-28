import { PaymentSourceType, RegistrationState, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { LanguageVersion, UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryInboxAgentRegistrationRequests } from '@/utils/db/lock-and-query-inbox-agent-registration-request';
import { retryOnSerializationConflict } from '@/utils/db/retry';
import { DEFAULTS, SERVICE_CONSTANTS } from '@masumi/payment-core/config';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
import { advancedRetry, delayErrorResolver } from 'advanced-retry';
import { Mutex, MutexInterface, tryAcquire } from 'async-mutex';
import { interpretBlockchainError } from '@/utils/errors/blockchain-error-interpreter';
import { sortUtxosByLovelaceDesc } from '@/utils/utxo';
import {
	connectExistingTransaction,
	createMeshProvider,
	createPendingTransaction,
	disconnectTransactionWallet,
	loadHotWalletSession,
	updateCurrentTransactionHash,
} from '@/services/shared';
import {
	generateRegistryAssetNameV2,
	generateRegistryMintTransaction,
	type RegistryMetadata,
	resolveRegistryFundingLovelace,
	resolveRegistryRecipientWalletAddress,
} from '@/services/registry/shared';
import {
	assertTxSizeWithinLimit,
	pickBatchCollateral,
	shrinkBatchToFit,
	WALLET_SPLITTER_LOVELACE,
} from '../../../builders/batch-helpers';
import { type BatchRegistryMintItem, generateRegistryBatchMintTransaction } from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { INBOX_AGENT_REGISTRATION_METADATA_TYPE } from '../metadata';

// Mirrors the V2 registry register cap. Inbox-agent items carry far less
// metadata than full agent registrations, so the tx-size pressure is lower
// and we could push higher; staying at 7 keeps the two paths uniform and
// well under MAX_SAFE_TX_BYTES.
const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryInboxAgentRegistrationRequests>>[number];
type InboxRequestRecord = LockedPaymentSource['InboxAgentRegistrationRequests'][number];

type ValidatedInboxItem = {
	request: InboxRequestRecord;
	item: BatchRegistryMintItem;
	assetName: string;
	policyId: string;
};

function buildInboxAgentMetadata(request: {
	name: string;
	description: string | null;
	agentSlug: string;
	metadataVersion: number;
}): RegistryMetadata {
	const metadata = {
		type: INBOX_AGENT_REGISTRATION_METADATA_TYPE,
		name: stringToMetadata(request.name),
		description: stringToMetadata(request.description),
		agentslug: stringToMetadata(request.agentSlug),
		metadata_version: request.metadataVersion.toString(),
	};
	return cleanMetadata(metadata) as RegistryMetadata;
}

async function markRequestFailed(request: InboxRequestRecord, error: unknown): Promise<void> {
	logger.error(`Error registering V2 inbox agent ${request.id}`, { error });
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.RegistrationFailed,
			error: interpretBlockchainError(error),
			SmartContractWallet: { update: { lockedAt: null } },
		},
	});
}

async function unlockHotWallet(hotWalletId: string): Promise<void> {
	try {
		await prisma.hotWallet.update({
			where: { id: hotWalletId, deletedAt: null },
			data: { lockedAt: null },
		});
	} catch (error) {
		logger.warn('Failed to release hot wallet lock after V2 inbox register batch bail-out', {
			hotWalletId,
			error,
		});
	}
}

function validateAndBuildItem(request: InboxRequestRecord, utxo: UTxO, policyId: string): ValidatedInboxItem {
	const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
	const fundingLovelace = resolveRegistryFundingLovelace(request);
	const assetName = generateRegistryAssetNameV2(utxo);
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

async function processSingleRegistration(
	validated: ValidatedInboxItem,
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
): Promise<void> {
	const request = validated.request;
	const walletSession = await loadHotWalletSession({
		network: paymentSource.network,
		rpcProviderApiKey: paymentSource.PaymentSourceConfig.rpcProviderApiKey,
		encryptedMnemonic: request.SmartContractWallet.Secret.encryptedMnemonic,
		hotWalletId: request.SmartContractWallet.id,
	});
	const { wallet, utxos, address } = walletSession;
	if (utxos.length === 0) {
		throw new Error('No UTXOs found for the wallet');
	}
	const blockchainProvider = await createMeshProvider(paymentSource.PaymentSourceConfig.rpcProviderApiKey);
	const collateralCheck = await ensureCollateralReady({
		walletDbId: request.SmartContractWallet.id,
		walletAddress: address,
		meshWallet: wallet,
		utxos,
		blockchainProvider,
		network,
		serviceLabel: 'inbox-register-single',
	});
	if (collateralCheck.status !== 'ready') {
		// IMPORTANT: do NOT throw on a non-ready collateral check from this
		// single-item path. The caller wraps `processSingleRegistration` in
		// `advancedRetry` then `markRequestFailed` on the final throw, which
		// would mark a transient "wallet not collateral-ready yet" condition
		// as a PERMANENT failure. Returning lets the request stay queued; the
		// next scheduler tick re-picks it up after the prep tx confirms.
		return;
	}
	const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);
	const firstUtxo = limitedFilteredUtxos[0];
	const collateralUtxo = limitedFilteredUtxos[0];
	const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
	const fundingLovelace = resolveRegistryFundingLovelace(request);
	const assetName = generateRegistryAssetNameV2(firstUtxo);
	const metadata = buildInboxAgentMetadata({
		name: request.name,
		description: request.description,
		agentSlug: request.agentSlug,
		metadataVersion: request.metadataVersion ?? DEFAULTS.DEFAULT_METADATA_VERSION,
	});
	const rpcApiKey = paymentSource.PaymentSourceConfig.rpcProviderApiKey;

	const evaluationTx = await generateRegistryMintTransaction(
		blockchainProvider,
		network,
		script,
		address,
		recipientWalletAddress,
		fundingLovelace,
		validated.policyId,
		assetName,
		firstUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		metadata,
		undefined,
		rpcApiKey,
		// V2 single-item splitter — see authorize-refund/service.ts.
		WALLET_SPLITTER_LOVELACE,
	);
	const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
		budget: { mem: number; steps: number };
	}>;
	const unsignedTx = await generateRegistryMintTransaction(
		blockchainProvider,
		network,
		script,
		address,
		recipientWalletAddress,
		fundingLovelace,
		validated.policyId,
		assetName,
		firstUtxo,
		collateralUtxo,
		limitedFilteredUtxos,
		metadata,
		estimatedFee[0].budget,
		rpcApiKey,
		WALLET_SPLITTER_LOVELACE,
	);
	const signedTx = await wallet.signTx(unsignedTx, true);
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.RegistrationInitiated,
			...createPendingTransaction(request.SmartContractWallet.id),
		},
	});
	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	await prisma.inboxAgentRegistrationRequest.update({
		where: { id: request.id },
		data: {
			agentIdentifier: validated.policyId + assetName,
			...updateCurrentTransactionHash(newTxHash),
		},
	});
	logger.debug(`Created V2 inbox agent registration transaction (single-item fallback):
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function registerInboxAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking V2 inbox registrations', { error: e });
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
				if (collateralCheck.status !== 'ready') {
					return;
				}

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
				const spendableUtxos = sortUtxosByLovelaceDesc(utxos);

				const validations = await Promise.allSettled(
					registrationRequests.map((request, idx) => {
						const utxo = spendableUtxos[idx];
						if (utxo == null) {
							throw new Error('Insufficient wallet UTXOs to assign a distinct firstUtxo to this request');
						}
						return Promise.resolve(validateAndBuildItem(request, utxo, policyId));
					}),
				);

				const validated: ValidatedInboxItem[] = [];
				for (let idx = 0; idx < validations.length; idx++) {
					const outcome = validations[idx];
					const request = registrationRequests[idx];
					if (outcome.status === 'fulfilled') {
						validated.push(outcome.value);
					} else if (outcome.reason instanceof Error && outcome.reason.message.includes('Insufficient wallet UTXOs')) {
						logger.warn(
							`Skipping V2 inbox register request ${request.id} this tick: not enough distinct wallet UTxOs in this batch`,
						);
					} else {
						await markRequestFailed(request, outcome.reason);
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
						blockchainProvider,
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
						blockchainProvider,
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
					assertTxSizeWithinLimit(unsignedTx, 'v2-inbox-batch-mint');
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
				} catch (signError) {
					logger.warn('V2 inbox register batch sign failed; falling back to single-item processing [batch-fallback]', {
						error:
							signError instanceof Error
								? { message: signError.message, stack: signError.stack, name: signError.name }
								: signError,
					});
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
		release();
	}
}

async function fallbackToSingleItems(
	validated: ValidatedInboxItem[],
	paymentSource: LockedPaymentSource,
	network: 'mainnet' | 'preprod',
	script: { version: LanguageVersion; code: string },
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
				await processSingleRegistration(v, paymentSource, network, script);
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
