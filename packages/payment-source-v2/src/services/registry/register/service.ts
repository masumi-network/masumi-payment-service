import {
	PaymentSourceType,
	RegistrationState,
	PricingType,
	TransactionStatus,
	X402PaymentScheme,
} from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import { logger } from '@masumi/payment-core/logger';
import type { UTxO } from '@meshsdk/core';
import { convertNetwork } from '@/utils/converter/network-convert';
import { lockAndQueryRegistryRequests } from '@/utils/db/lock-and-query-registry-request';
import { retryOnSerializationConflict } from '@masumi/payment-core/db-retry';
import { DEFAULTS } from '@masumi/payment-core/config';
import { getRegistryScriptFromNetworkHandlerV2 } from '@/utils/generator/contract-generator';
import { stringToMetadata, cleanMetadata } from '@/utils/converter/metadata-string-convert';
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
	type RegistryMetadata,
	registryNonceForIndex,
	resolveRegistryFundingLovelace,
	resolveRegistryRecipientWalletAddress,
	V2_REGISTRY_MAX_MINTS_PER_UTXO,
} from '@/services/registry/shared';
import {
	assertTxSizeWithinLimit,
	isTxSizeWithinLimit,
	pickBatchCollateral,
	shrinkBatchToFit,
} from '../../../builders/batch-helpers';
import { type BatchRegistryMintItem, generateRegistryBatchMintTransaction } from '../../../builders/batch-registry';
import { ensureCollateralReady } from '../../wallet-collateral/ensure-collateral-ready';
import {
	MAX_COLLATERAL_PREP_FAILURES,
	recordRegistryPrepFailure,
	resetRegistryPrepFailureCount,
} from '../../wallet-collateral/prep-failure-guard';
import { unlockHotWalletIfNoPendingTransaction } from '../../wallet-lock-helpers';
import { asV2Provider } from '../../provider-cast';
import {
	MAX_SUPPORTED_PAYMENT_SOURCES,
	SupportedPaymentSourceChain,
	type RegistryMetadataPaymentSource,
} from '@/types/payment-source';
import { verificationRowToApi, verificationsToMetadata, type AgentVerificationRow } from '@/types/verification';

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
// overran MAX_SAFE_TX_BYTES. The size-aware shrink below is the real guard —
// this cap just keeps the common case from wasting build passes on a batch
// that will always shrink.
const REGISTRY_BATCH_SIZE = 5;

const mutex = new Mutex();

type RegistrySupportedPaymentSourceMetadataRow = {
	chain: string;
	network: string;
	paymentSourceType: PaymentSourceType | null;
	address: string;
	scheme?: X402PaymentScheme | null;
	pricingType?: PricingType | null;
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
	// An explicit source list is authoritative: this is what lets a V2 agent
	// advertise x402 only. Empty legacy rows still receive the active Cardano
	// source so registrations created before explicit rail selection retain
	// their historical Masumi behavior.
	const defaultCardanoSource = {
		chain: SupportedPaymentSourceChain.Cardano,
		network: paymentSource.network,
		paymentSourceType: paymentSource.paymentSourceType,
		address: paymentSource.smartContractAddress,
	};
	const supportedPaymentSources =
		request.SupportedPaymentSources.length > 0 ? request.SupportedPaymentSources : [defaultCardanoSource];
	if (supportedPaymentSources.length > MAX_SUPPORTED_PAYMENT_SOURCES) {
		throw new Error(
			`Cannot register agent: ${supportedPaymentSources.length} payment sources exceed ` +
				`the on-chain maximum of ${MAX_SUPPORTED_PAYMENT_SOURCES}`,
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
						if (source.chain === SupportedPaymentSourceChain.EVM) {
							if (source.pricingType == null || source.payTo == null) {
								throw new Error('Cannot register agent: x402 supported payment source is incomplete');
							}
							if (
								source.pricingType === PricingType.Fixed &&
								(source.amount == null || source.decimals == null || source.asset == null)
							) {
								throw new Error('Cannot register agent: fixed x402 pricing is incomplete');
							}
							if (
								source.pricingType === PricingType.Dynamic &&
								((source.asset == null) !== (source.decimals == null) || source.amount != null)
							) {
								throw new Error('Cannot register agent: dynamic x402 pricing is incomplete');
							}
							if (
								source.pricingType === PricingType.Free &&
								(source.asset != null || source.amount != null || source.decimals != null)
							) {
								throw new Error('Cannot register agent: free x402 pricing must not include an asset or amount');
							}
							return {
								chain: stringToMetadata(source.chain),
								network: stringToMetadata(String(source.network)),
								settlement: {
									scheme: stringToMetadata(source.scheme ?? X402PaymentScheme.Exact),
									payTo: stringToMetadata(source.payTo),
									resource: stringToMetadata(source.resource),
									// Prisma represents an omitted nullable JSON field as null.
									// Cardano metadata has no null value, so omit it before Mesh
									// recursively converts this object to metadatum.
									extra: source.extra ?? undefined,
								},
								pricing: {
									pricingType: source.pricingType,
									...(source.pricingType === PricingType.Fixed
										? {
												fixed: [
													{
														asset: stringToMetadata(source.asset, false),
														amount: String(source.amount),
														decimals: String(source.decimals),
													},
												],
											}
										: {}),
									...(source.pricingType === PricingType.Dynamic && source.asset != null
										? {
												dynamic: [
													{
														asset: stringToMetadata(source.asset, false),
														decimals: String(source.decimals),
													},
												],
											}
										: {}),
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
 * Peel registry items off the END of a pre-sorted batch until the built
 * (default-exUnits) tx fits within MAX_SAFE_TX_BYTES, returning the largest
 * fitting prefix plus its evaluation tx (so the caller can reuse it for the
 * evaluateTx fee pass without rebuilding). Tx size does not depend on the
 * evaluated redeemer budget, so the default-exUnits build is a faithful size
 * proxy for the final budgeted build.
 *
 * This is the async analogue of `shrinkBatchToFit`: the builder is async and
 * therefore cannot run inside that helper's synchronous predicate. Returns
 * `fit: []` when even a single item overruns the cap, signalling the caller to
 * route that item through the single-item fallback.
 */
async function shrinkRegistryBatchToTxSize(
	fit: ValidatedRegistryItem[],
	buildEvalTx: (items: BatchRegistryMintItem[]) => Promise<string>,
): Promise<{ fit: ValidatedRegistryItem[]; evaluationTx: string; dropped: number }> {
	let working = fit;
	while (working.length > 0) {
		const evaluationTx = await buildEvalTx(working.map((v) => v.item));
		if (isTxSizeWithinLimit(evaluationTx)) {
			return { fit: working, evaluationTx, dropped: fit.length - working.length };
		}
		working = working.slice(0, working.length - 1);
	}
	return { fit: [], evaluationTx: '', dropped: fit.length };
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
							// Mid-batch: keep the shared wallet lock (see markRequestFailed).
							await markRequestFailed(request, outcome.reason, { unlockWallet: false });
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
					// time). Forcing the current separate-collateral policy onto
					// mint-only batches would block 1-UTxO wallets from minting at
					// all. Tx-size is checked inline after the build pass via
					// assertTxSizeWithinLimit further down.
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

					// Size-aware pre-shrink. The combined CIP-25 metadata block (one
					// `721` label spanning every item, see batch-registry.ts) grows with
					// both batch size and per-agent metadata (verification claims, example
					// outputs, payment sources). A full batch can overrun
					// MAX_SAFE_TX_BYTES. Build with default exUnits (tx size is
					// independent of the evaluated budget) and peel items off the END
					// until the batch fits, preserving the largest viable batch. Dropped
					// items stay in RegistrationRequested and re-batch on the next tick.
					let fit = shrinkResult.fit;
					let evaluationTx: string;
					try {
						const sized = await shrinkRegistryBatchToTxSize(fit, (subsetItems) =>
							generateRegistryBatchMintTransaction(
								asV2Provider(blockchainProvider),
								network,
								script,
								address,
								policyId,
								subsetItems,
								collateralUtxo,
								spendableUtxos,
								undefined,
								rpcApiKey,
							),
						);
						if (sized.fit.length === 0) {
							// The highest-priority item alone exceeds the tx-size cap — its
							// metadata is too large to ever mint as-is. Fail it hard; the
							// remaining items keep their queued state and re-batch next tick
							// without it (markRequestFailed clears the shared wallet lock).
							logger.error('V2 register batch: a single item exceeds the tx-size cap; marking it failed', {
								requestId: fit[0].request.id,
							});
							await markRequestFailed(
								fit[0].request,
								new Error('Agent metadata is too large to mint within the transaction size limit'),
							);
							return;
						}
						if (sized.dropped > 0) {
							logger.warn(
								`V2 register batch shrunk from ${fit.length} to ${sized.fit.length} for tx-size; deferring ${sized.dropped} to next tick`,
							);
						}
						fit = sized.fit;
						evaluationTx = sized.evaluationTx;
					} catch (sizeError) {
						logger.error('V2 register batch size-shrink build failed; marking batch failed', {
							error:
								sizeError instanceof Error
									? { message: sizeError.message, stack: sizeError.stack, name: sizeError.name }
									: sizeError,
							batchSize: fit.length,
						});
						await markBatchFailed(fit, sizeError);
						return;
					}

					const items = fit.map((v) => v.item);

					let unsignedTx: string;
					try {
						// Two-pass evaluateTx: pass 1 (the size-shrink build above, reused
						// here as `evaluationTx`) with default exUnits; pass 2 with the
						// single MINT redeemer budget the validator returns (V2 mint
						// contract shares one redeemer for the whole policy bucket).
						const estimatedFee = (await blockchainProvider.evaluateTx(evaluationTx)) as Array<{
							tag?: string;
							budget: { mem: number; steps: number };
						}>;
						const mintBudget = estimatedFee.find((action) => action.tag === 'MINT')?.budget ?? estimatedFee[0]?.budget;
						if (mintBudget == null) {
							throw new Error('evaluateTx returned no MINT budget for V2 register batch');
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
						assertTxSizeWithinLimit(unsignedTx, 'v2-registry-batch-mint');
					} catch (batchError) {
						logger.error('V2 register batch build failed; marking batch failed', {
							error:
								batchError instanceof Error
									? { message: batchError.message, stack: batchError.stack, name: batchError.name }
									: batchError,
							batchSize: fit.length,
						});
						await markBatchFailed(fit, batchError);
						return;
					}

					let signedTx: string;
					try {
						signedTx = await wallet.signTx(unsignedTx, true);
					} catch (signError) {
						logger.error('V2 register batch sign failed; marking batch failed', {
							error:
								signError instanceof Error
									? { message: signError.message, stack: signError.stack, name: signError.name }
									: signError,
							batchSize: fit.length,
						});
						await markBatchFailed(fit, signError);
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
