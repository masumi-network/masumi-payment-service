import {
	PaymentSourceType,
	RegistrationState,
	PricingType,
	TransactionStatus,
	X402PaymentScheme,
} from '@/generated/prisma/client';
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
} from '@/services/shared';
import {
	generateRegistryAssetNameV2,
	generateRegistryMintTransaction,
	type RegistryMetadata,
	registryNonceForIndex,
	resolveRegistryFundingLovelace,
	resolveRegistryRecipientWalletAddress,
	V2_REGISTRY_MAX_MINTS_PER_UTXO,
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
	MAX_SUPPORTED_PAYMENT_SOURCES,
	SupportedPaymentSourceChain,
	type RegistryMetadataPaymentSource,
} from '@/types/payment-source';
import { verificationRowToApi, verificationsToMetadata, type AgentVerificationRow } from '@/types/verification';

// V2 registry batch sizing. The on-chain `MintAction` validator runs once for
// the policy bucket and verifies every minted asset name against the set of
// spent inputs, so the per-item cost is mostly off-chain (CIP-25 metadata + a
// fresh wallet UTxO per asset). The cap balances tx-size headroom (we keep
// well under MAX_SAFE_TX_BYTES) against scheduler throughput.
const REGISTRY_BATCH_SIZE = 7;

const mutex = new Mutex();

type RegistrySupportedPaymentSourceMetadataRow = {
	chain: string;
	network: string;
	paymentSourceType: PaymentSourceType | null;
	address: string;
	scheme?: X402PaymentScheme | null;
	asset?: string | null;
	amount?: bigint | string | null;
	decimals?: number | null;
	payTo?: string | null;
	resource?: string | null;
	extra?: unknown;
};

type LockedPaymentSource = Awaited<ReturnType<typeof lockAndQueryRegistryRequests>>[number];
type RegistryRequestRecord = LockedPaymentSource['RegistryRequest'][number];

type ValidatedRegistryItem = {
	request: RegistryRequestRecord;
	item: BatchRegistryMintItem;
	assetName: string;
	policyId: string;
};

export function validateRegistrationPricing(request: {
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

export function buildAgentMetadata(
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
		SupportedPaymentSources: RegistrySupportedPaymentSourceMetadataRow[];
		// Persisted AgentVerification rows; reshaped to nested form before emit.
		Verifications?: AgentVerificationRow[];
	},
	paymentSource: RegistryMetadataPaymentSource,
): RegistryMetadata {
	// A Cardano escrow source must always be present: V2 drops the top-level
	// agentPricing and folds the agent's pricing into the Cardano source, so an
	// entry advertising only x402/EVM sources would otherwise carry no Cardano
	// pricing at all (breaking purchase/query, which resolve price from it).
	const defaultCardanoSource = {
		chain: SupportedPaymentSourceChain.Cardano,
		network: paymentSource.network,
		paymentSourceType: paymentSource.paymentSourceType,
		address: paymentSource.smartContractAddress,
	};
	const hasCardanoSource = request.SupportedPaymentSources.some(
		(source) => source.chain === SupportedPaymentSourceChain.Cardano,
	);
	const supportedPaymentSources = hasCardanoSource
		? request.SupportedPaymentSources
		: [defaultCardanoSource, ...request.SupportedPaymentSources];
	// Guard the auto-injected Cardano source against overflowing the on-chain cap:
	// emitting more than the max would make the entry fail its own re-parse, so a
	// caller at the limit must leave room for the mandatory Cardano source.
	if (supportedPaymentSources.length > MAX_SUPPORTED_PAYMENT_SOURCES) {
		throw new Error(
			`Cannot register agent: ${supportedPaymentSources.length} payment sources exceed ` +
				`the on-chain maximum of ${MAX_SUPPORTED_PAYMENT_SOURCES}` +
				(hasCardanoSource
					? ''
					: ` (a Cardano source is added automatically; provide at most ${
							MAX_SUPPORTED_PAYMENT_SOURCES - 1
						} other sources)`),
		);
	}
	// Cardano sources advertise the agent's pricing inline (one self-contained
	// payable option per source), mirroring how x402 sources carry their own
	// amount. Derived from the same `request.Pricing` that still feeds the
	// top-level `agentPricing` block, so the two stay consistent.
	const cardanoPricingMetadata =
		request.Pricing.pricingType == PricingType.Fixed
			? {
					pricingType: PricingType.Fixed,
					fixed: (request.Pricing.FixedPricing?.Amounts ?? []).map((pricing) => ({
						asset: stringToMetadata(pricing.unit, false),
						amount: pricing.amount.toString(),
					})),
				}
			: { pricingType: request.Pricing.pricingType };
	// Optional KERI/Veridian verification claims (see @masumi/payment-core/
	// verification). Gated on the same metadata version as supported_payment_sources
	// (a v2-metadata concept); self-describing on chain for third-party verification.
	const verificationRows = request.Verifications ?? [];
	const verificationsMetadata =
		request.metadataVersion >= DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION && verificationRows.length > 0
			? verificationsToMetadata(verificationRows.map(verificationRowToApi), stringToMetadata)
			: undefined;
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
		image: stringToMetadata(DEFAULTS.DEFAULT_IMAGE),
		metadata_version: request.metadataVersion.toString(),
		supported_payment_sources:
			request.metadataVersion >= DEFAULTS.DEFAULT_REGISTRY_METADATA_VERSION
				? supportedPaymentSources.map((source) => {
						if (
							source.chain === SupportedPaymentSourceChain.EVM &&
							(source.amount == null || source.decimals == null || source.asset == null || source.payTo == null)
						) {
							// Never mint an incomplete x402 source on-chain as the literal strings
							// "null"/"undefined"; fail the registration so the bad row is surfaced.
							throw new Error('Cannot register agent: x402 supported payment source is incomplete');
						}
						if (source.chain === SupportedPaymentSourceChain.EVM) {
							return {
								chain: stringToMetadata(source.chain),
								network: stringToMetadata(String(source.network)),
								settlement: {
									scheme: stringToMetadata(source.scheme ?? X402PaymentScheme.Exact),
									payTo: stringToMetadata(source.payTo),
									resource: stringToMetadata(source.resource),
									extra: source.extra,
								},
								pricing: {
									pricingType: PricingType.Fixed,
									fixed: [
										{
											asset: stringToMetadata(source.asset, false),
											amount: String(source.amount),
											decimals: String(source.decimals),
										},
									],
								},
							};
						}
						return {
							chain: stringToMetadata(source.chain),
							network: stringToMetadata(String(source.network)),
							settlement: {
								paymentSourceType:
									source.paymentSourceType != null ? stringToMetadata(source.paymentSourceType) : undefined,
								address: stringToMetadata(source.address),
							},
							pricing: cardanoPricingMetadata,
						};
					})
				: undefined,
		verifications: verificationsMetadata,
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

	// Submit FIRST, then write DB. Previous order (DB row → submitTx) left
	// an orphan Pending Transaction row holding BlocksWallet → wallet
	// whenever submitTx threw: the request was stuck in
	// RegistrationInitiated with no txHash until wallet-timeouts swept
	// minutes later. With submit-first there is no DB row to clean up
	// on submit failure — the catch arm only reverts state back to
	// RegistrationRequested and clears the wallet lock, no orphan Tx to
	// roll back. Matches the payment/purchase single-item pattern.
	let newTxHash: string;
	try {
		newTxHash = await wallet.submitTx(signedTx);
	} catch (error) {
		logger.error('Error submitting V2 register single-item tx', { error, requestId: request.id });
		await prisma.registryRequest.update({
			where: { id: request.id },
			data: {
				state: RegistrationState.RegistrationRequested,
				SmartContractWallet: {
					update: {
						lockedAt: null,
					},
				},
			},
		});
		return;
	}

	await walletSession.evaluateProjectedBalance(unsignedTx, limitedFilteredUtxos);

	// Create the Transaction row WITH txHash already populated — single
	// update advances state AND attaches the real on-chain txHash.
	// Wrapped in retryOnSerializationConflict so a transient conflict
	// retries-and-gives-up locally instead of bubbling out to a
	// caller-level retry that could double-submit.
	await retryOnSerializationConflict(
		() =>
			prisma.registryRequest.update({
				where: { id: request.id },
				data: {
					state: RegistrationState.RegistrationInitiated,
					agentIdentifier: validated.policyId + assetName,
					...createPendingTransaction(request.SmartContractWallet.id, newTxHash),
				},
			}),
		{ label: 'v2-register-single-post-submit' },
	);
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
							validateAndBuildItem(request, sharedFirstUtxo, policyId, paymentSource, registryNonceForIndex(idx)),
						),
					);

					const validated: ValidatedRegistryItem[] = [];
					for (let idx = 0; idx < validations.length; idx++) {
						const outcome = validations[idx];
						const request = mintableRequests[idx];
						if (outcome.status === 'fulfilled') {
							validated.push(outcome.value);
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
						logger.warn('V2 register batch submit failed; rolling back DB and retrying as single items', {
							error:
								submitError instanceof Error
									? { message: submitError.message, stack: submitError.stack, name: submitError.name }
									: submitError,
						});
						// Rollback the pre-submit transition so a stale
						// CurrentTransaction doesn't pin the wallet.
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
								{ label: 'v2-register-batch-tx' },
							);
						} catch (rollbackError) {
							logger.error('V2 register batch rollback after submit failure failed; skipping single-item fallback', {
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
