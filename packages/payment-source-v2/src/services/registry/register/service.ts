import { PaymentSourceType, RegistrationState, PricingType, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { LanguageVersion, UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
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
import {
	SupportedPaymentSourceChain,
	type RegistryMetadataPaymentSource,
	type SupportedPaymentSource,
} from '@/types/payment-source';

// V2 registry batch sizing. The on-chain `MintAction` validator runs once for
// the policy bucket and verifies every minted asset name against the set of
// spent inputs, so the per-item cost is mostly off-chain (CIP-25 metadata + a
// fresh wallet UTxO per asset). The cap balances tx-size headroom (we keep
// well under MAX_SAFE_TX_BYTES) against scheduler throughput.
const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

type ValidatedRegistryItem = {
	request: RegistryRequestRecord;
	item: BatchRegistryMintItem;
	assetName: string;
	policyId: string;
};

function validateRegistrationPricing(request: {
	Pricing: {
		pricingType: PricingType;
		FixedPricing: { Amounts: Array<{ unit: string; amount: bigint }> } | null;
	};
}): void {
	if (
		request.Pricing.pricingType != PricingType.Fixed &&
		request.Pricing.pricingType != PricingType.Free &&
		request.Pricing.pricingType != PricingType.Dynamic
	) {
		throw new Error('Unsupported pricing type: ' + String(request.Pricing.pricingType));
	}
	if (
		request.Pricing.pricingType == PricingType.Fixed &&
		(request.Pricing.FixedPricing == null || request.Pricing.FixedPricing.Amounts.length == 0)
	) {
		throw new Error('No fixed pricing found, this is likely a bug');
	}
	if (request.Pricing.pricingType != PricingType.Fixed && request.Pricing.FixedPricing != null) {
		throw new Error('Non-fixed pricing requires no fixed pricing to be set');
	}
}

function buildAgentMetadata(
	request: {
		name: string;
		description: string | null;
		apiBaseUrl: string | null;
		ExampleOutputs: Array<{ name: string; mimeType: string; url: string }>;
		capabilityName?: string | null;
		capabilityVersion?: string | null;
		authorName: string | null;
		authorContactEmail: string | null;
		authorContactOther: string | null;
		authorOrganization: string | null;
		privacyPolicy: string | null;
		terms: string | null;
		other: string | null;
		tags: string[];
		Pricing: {
			pricingType: PricingType;
			FixedPricing?: {
				Amounts: Array<{ unit: string; amount: bigint }>;
			} | null;
		};
		metadataVersion: number;
		SupportedPaymentSources: SupportedPaymentSource[];
	},
	paymentSource: RegistryMetadataPaymentSource,
): RegistryMetadata {
	const supportedPaymentSources =
		request.SupportedPaymentSources.length > 0
			? request.SupportedPaymentSources
			: [
					{
						chain: SupportedPaymentSourceChain.Cardano,
						network: paymentSource.network,
						paymentSourceType: paymentSource.paymentSourceType,
						address: paymentSource.smartContractAddress,
					},
				];
	const metadata = {
		name: stringToMetadata(request.name),
		description: stringToMetadata(request.description),
		api_base_url: stringToMetadata(request.apiBaseUrl),
		example_output: request.ExampleOutputs.map((exampleOutput) => ({
			name: stringToMetadata(exampleOutput.name),
			mime_type: stringToMetadata(exampleOutput.mimeType),
			url: stringToMetadata(exampleOutput.url),
		})),
		capability:
			request.capabilityName && request.capabilityVersion
				? {
						name: stringToMetadata(request.capabilityName),
						version: stringToMetadata(request.capabilityVersion),
					}
				: undefined,
		author: {
			name: stringToMetadata(request.authorName),
			contact_email: stringToMetadata(request.authorContactEmail),
			contact_other: stringToMetadata(request.authorContactOther),
			organization: stringToMetadata(request.authorOrganization),
		},
		legal: {
			privacy_policy: stringToMetadata(request.privacyPolicy),
			terms: stringToMetadata(request.terms),
			other: stringToMetadata(request.other),
		},
		tags: request.tags,
		agentPricing:
			request.Pricing.pricingType == PricingType.Fixed
				? {
						pricingType: PricingType.Fixed,
						fixedPricing:
							request.Pricing.FixedPricing?.Amounts.map((pricing) => ({
								unit: stringToMetadata(pricing.unit),
								amount: pricing.amount.toString(),
							})) ?? [],
					}
				: {
						pricingType: request.Pricing.pricingType,
					},
		image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
		metadata_version: request.metadataVersion.toString(),
		supported_payment_sources:
			request.metadataVersion >= DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION
				? supportedPaymentSources.map((source) => ({
						chain: stringToMetadata(source.chain),
						network: stringToMetadata(source.network),
						paymentSourceType: stringToMetadata(source.paymentSourceType),
						address: stringToMetadata(source.address),
					}))
				: undefined,
	};
	return cleanMetadata(metadata) as RegistryMetadata;
}

async function markRequestFailed(request: RegistryRequestRecord, error: unknown): Promise<void> {
	logger.error(`Error registering V2 agent ${request.id}`, { error });
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.RegistrationFailed,
			error: interpretBlockchainError(error),
			SmartContractWallet: { update: { lockedAt: null } },
		},
	});
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
	paymentSource: RegistryMetadataPaymentSource,
): ValidatedRegistryItem {
	validateRegistrationPricing(request);
	const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
	const fundingLovelace = resolveRegistryFundingLovelace(request);
	// V2 mint contract requires the structured asset name
	// [1B nonce>0x0f | 28B blake2b_224 | 3B version 0x000000] — the V1 flat
	// blake2b_256 layout would fail every check.
	const assetName = generateRegistryAssetNameV2(utxo);
	const metadata = buildAgentMetadata(request, paymentSource);
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

/**
 * Single-item fallback. Used when batch build / submit fails — we re-process
 * each request one at a time in the same tick so a single bad item doesn't
 * sink a whole batch's worth of throughput.
 */
async function processSingleRegistration(
	validated: ValidatedRegistryItem,
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
		serviceLabel: 'registry-register-single',
	});
	if (collateralCheck.status !== 'ready') {
		// IMPORTANT: do NOT throw on a non-ready collateral check from this
		// single-item path. The caller wraps `processSingleRegistration` in
		// `advancedRetry` then `markRequestFailed` on the final throw — which
		// would mark a transient "wallet not collateral-ready yet" condition
		// as a PERMANENT failure (RegistrationFailed). Returning instead lets
		// the caller observe success-without-effect; the request stays in
		// its current queued state and the next scheduler tick re-picks it up
		// after the prep tx confirms and the wallet is unlocked. The helper
		// has already logged the deferral / failure at WARN/ERROR level for
		// the operator.
		return;
	}
	const limitedFilteredUtxos = sortUtxosByLovelaceDesc(utxos);
	const firstUtxo = limitedFilteredUtxos[0];
	const collateralUtxo = limitedFilteredUtxos[0];
	const recipientWalletAddress = resolveRegistryRecipientWalletAddress(request);
	const fundingLovelace = resolveRegistryFundingLovelace(request);
	const assetName = generateRegistryAssetNameV2(firstUtxo);
	const metadata = buildAgentMetadata(request, paymentSource);
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
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			state: RegistrationState.RegistrationInitiated,
			...createPendingTransaction(request.SmartContractWallet.id),
		},
	});
	const newTxHash = await wallet.submitTx(signedTx);
	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);
	await prisma.registryRequest.update({
		where: { id: request.id },
		data: {
			agentIdentifier: validated.policyId + assetName,
			...updateCurrentTransactionHash(newTxHash),
		},
	});
	logger.debug(`Created V2 register transaction (single-item fallback):
              Tx ID: ${newTxHash}
              View on https://${network === 'preprod' ? 'preprod.' : ''}cardanoscan.io/transaction/${newTxHash}
          `);
}

export async function registerAgentV2() {
	let release: MutexInterface.Releaser | null;
	try {
		release = await tryAcquire(mutex).acquire();
	} catch (e) {
		logger.info('Mutex timeout when locking', { error: e });
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
							error: error instanceof Error ? { message: error.message, stack: error.stack, name: error.name } : error,
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
				if (collateralCheck.status !== 'ready') {
					return;
				}

				// Pick collateral FIRST (smallest pure-ADA UTxO >= 5 ADA) so the
				// remaining sorted-by-lovelace pool can drive distinct
				// per-item `firstUtxo`s without overlap. Conway rejects
				// collateral that carries any non-ADA asset, so we never fall
				// back to a non-pure UTxO — if none exists, defer to the next
				// tick when the wallet may have more UTxOs.
				const collateralUtxo = pickBatchCollateral(utxos, []);
				if (collateralUtxo == null) {
					logger.warn(
						'V2 register batch: no wallet UTxO has enough lovelace to serve as collateral (>=5 ADA); deferring to next tick',
					);
					await unlockHotWallet(firstRequest.SmartContractWallet.id);
					return;
				}

				// MINT-only tx: Conway phase-1 does NOT forbid the collateral UTxO
				// from also appearing in the (non-script) spending input set, and
				// the V1 single-tx register builder already exploits this — it
				// passes the same UTxO as both `firstUtxo` and `collateralUtxo`,
				// and Mesh-SDK routes them into separate body fields. We follow
				// the same pattern here so a wallet with K UTxOs can drive a
				// batch of min(K, registryRequests.length) items (rather than
				// K-1, which would block a 1-UTxO wallet entirely).
				const spendableUtxos = sortUtxosByLovelaceDesc(utxos);

				// Validate every request in parallel. Failures here become
				// per-request RegistrationFailed updates and are removed from
				// the batch.
				const validations = await Promise.allSettled(
					registryRequests.map((request, idx) => {
						const utxo = spendableUtxos[idx];
						if (utxo == null) {
							throw new Error('Insufficient wallet UTXOs to assign a distinct firstUtxo to this request');
						}
						return Promise.resolve(validateAndBuildItem(request, utxo, policyId, paymentSource));
					}),
				);

				const validated: ValidatedRegistryItem[] = [];
				for (let idx = 0; idx < validations.length; idx++) {
					const outcome = validations[idx];
					const request = registryRequests[idx];
					if (outcome.status === 'fulfilled') {
						validated.push(outcome.value);
					} else if (outcome.reason instanceof Error && outcome.reason.message.includes('Insufficient wallet UTXOs')) {
						// Not a per-request failure — wallet ran out of distinct
						// UTxOs for the tail items. Leave the request in
						// RegistrationRequested so the next tick (with more
						// UTxOs or a smaller batch) can pick it up.
						logger.warn(
							`Skipping V2 register request ${request.id} this tick: not enough distinct wallet UTxOs in this batch`,
						);
					} else {
						await markRequestFailed(request, outcome.reason);
					}
				}

				if (validated.length === 0) {
					logger.info('No V2 register requests passed validation this tick');
					await unlockHotWallet(firstRequest.SmartContractWallet.id);
					return;
				}

				// Shrink the batch until tx-size is safe. We do NOT pre-check
				// no-collateral-overlap here: the mint path tolerates the
				// `firstUtxo == collateral` case (mesh routes the ref into both
				// body fields and dedupes the collateral side at assembly
				// time), and enforcing disjointness would block 1-UTxO wallets
				// from minting at all. Tx-size is checked inline after the
				// build pass via assertTxSizeWithinLimit further down.
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

				const fit = shrinkResult.fit;
				const items = fit.map((v) => v.item);

				let unsignedTx: string;
				try {
					// Two-pass evaluateTx: pass 1 with default exUnits, pass 2
					// with the single MINT redeemer budget the validator
					// returns (V2 mint contract shares one redeemer for the
					// whole policy bucket).
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
						throw new Error('evaluateTx returned no MINT budget for V2 register batch');
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
					assertTxSizeWithinLimit(unsignedTx, 'v2-registry-batch-mint');
				} catch (batchError) {
					logger.warn('V2 register batch build failed; falling back to single-item processing [batch-fallback]', {
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
					logger.warn('V2 register batch sign failed; falling back to single-item processing [batch-fallback]', {
						error:
							signError instanceof Error
								? { message: signError.message, stack: signError.stack, name: signError.name }
								: signError,
					});
					await fallbackToSingleItems(fit, paymentSource, network, script);
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
								{ timeout: 30_000 },
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
					logger.warn('V2 register batch submit failed; rolling back DB and retrying as single items', {
						error:
							submitError instanceof Error
								? { message: submitError.message, stack: submitError.stack, name: submitError.name }
								: submitError,
					});
					// Rollback the pre-submit transition so a stale
					// CurrentTransaction doesn't pin the wallet.
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
												state: RegistrationState.RegistrationRequested,
												CurrentTransaction:
													shouldReconnect && v.request.currentTransactionId != null
														? { connect: { id: v.request.currentTransactionId } }
														: { disconnect: true },
											},
										});
									}
								},
								{ timeout: 30_000 },
							),
						{ label: 'v2-register-batch-tx' },
					);
					await fallbackToSingleItems(fit, paymentSource, network, script);
					// Rollback only cleared pendingTransactionId; lockedAt stays set. Conditional
					// unlock prevents the wallet from orphan-locking when every single-item fallback
					// deferred — preserves the lock when a single-item submit succeeded.
					await unlockHotWalletIfNoPendingTransaction(
						firstRequest.SmartContractWallet.id,
						'v2-register-batch-rollback',
					);
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
								{ timeout: 30_000 },
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
			}),
		);
	} catch (error) {
		logger.error('Error registering V2 agents', { error });
	} finally {
		release();
	}
}

async function fallbackToSingleItems(
	validated: ValidatedRegistryItem[],
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
