// Sync mesh-sdk's bundled Plutus cost models with what the chain actually
// uses. This is a workaround for an upstream gap in @meshsdk/core
// 1.9.0-beta.* up to and including the current `latest` on npm (.102):
// MeshTxBuilder hardcodes the imported DEFAULT_V*_COST_MODEL_LIST arrays
// into hashScriptData(), and the Protocol type accepted by
// `.protocolParams(...)` has no cost-model fields, so there is no public API
// to inject chain-current cost models.
//
// Symptom when out of date: ledger rejects submission with
//   ConwayUtxowFailure (PPViewHashesDontMatch ...)
// because mesh's locally-computed script_data_hash uses stale cost models
// while the ledger recomputes from the live on-chain cost models. The hashes
// are deterministic across runs, which makes the failure look like a code
// regression even though it is a static-data drift between the SDK and the
// chain after a Cardano protocol parameter update.
//
// Trick: the lists are exported as mutable arrays from `@meshsdk/common` (and
// re-exported by `@meshsdk/core`'s top-level `export *`). Mesh's internal
// hashScriptData captures the array by reference at import time, so mutating
// the array in place (clearing it and pushing chain values) updates what
// mesh sees from the next tx build onward.
//
// We pull `cost_models_raw` from Blockfrost's `/epochs/latest/parameters`
// because that response already contains the canonical ordered list the
// ledger uses; no need to re-derive ordering. The same call returns the
// mesh-format Protocol that `MeshTxBuilder.protocolParams(...)` accepts, so
// we cache both alongside one another and let tx builders skip a second
// roundtrip. The sync is memoized per Blockfrost API key for
// {@link CACHE_TTL_MS} so we do not hammer Blockfrost.
//
// Long-term fix: upstream PR to mesh-sdk to expose a cost-model setter on
// MeshTxBuilder, or migrate off mesh-sdk for tx building.

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { withCostModelLock } from './build-lock';
// `@meshsdk/core` re-exports `@meshsdk/common`'s symbols (`export * from
// '@meshsdk/common'`), so we can import from core to avoid adding
// `@meshsdk/common` as a direct workspace dep. The arrays we mutate ARE the
// same references mesh's internal hashScriptData uses — JS modules give us a
// live binding to the array object, not a copy.
import {
	BlockfrostProvider,
	DEFAULT_V1_COST_MODEL_LIST,
	DEFAULT_V2_COST_MODEL_LIST,
	DEFAULT_V3_COST_MODEL_LIST,
} from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';

// Mesh's `Protocol` type has no convenient public export across versions, so
// keep the cached value typed as `unknown`. Callers pass it straight back into
// `MeshTxBuilder.protocolParams(...)` which accepts the runtime shape.
type CachedSync = {
	protocolParameters: unknown;
	at: number;
};

// Network fetches remain cached by provider key. Every application of those
// cached models and every build share a process-wide lock because the SDK
// arrays are global. This also protects a pinned Hydra head from an L1 sync.
const inFlightByKey = new Map<string, Promise<unknown>>();
const lastSyncByKey = new Map<string, CachedSync>();

/** Hold through sync, build and sign. Submission does not need this lock. */
export async function withMeshCostModelLock<T>(_blockfrostApiKey: string, operation: () => Promise<T>): Promise<T> {
	return await withCostModelLock(operation);
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function replaceListInPlace(target: number[], next: unknown): boolean {
	if (!Array.isArray(next)) return false;
	const cleaned: number[] = [];
	for (const value of next) {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) {
			return false;
		}
		cleaned.push(numeric);
	}
	target.length = 0;
	for (const value of cleaned) {
		target.push(value);
	}
	return true;
}

/**
 * Last raw `cost_models_raw` payload fetched from Blockfrost, keyed by API key.
 * The shared sync helper patches the V1 mesh line's bundled cost-model arrays;
 * V2-pinned consumers (see `packages/payment-source-v2/src/utils/mesh-cost-model-sync.ts`)
 * read this cached payload to also patch their own (separate) mesh-sdk
 * cost-model arrays without re-hitting Blockfrost.
 *
 * Returns `null` until the first successful `syncMeshCostModelsFromChain(key)`.
 * Stays valid until the next sync overwrites it; we intentionally do NOT
 * TTL-expire it here (the apply step is idempotent — over-applying stale
 * models is no worse than under-applying them, and the V2 helper has its own
 * fetch freshness decision based on `lastSyncByKey`).
 */
type RawCostModels = { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown };
const lastRawCostModelsByKey = new Map<string, RawCostModels>();

export function getCachedRawCostModels(blockfrostApiKey: string): RawCostModels | null {
	return lastRawCostModelsByKey.get(blockfrostApiKey) ?? null;
}

// Max attempts to obtain a cost-models + protocol-params pair from the SAME
// epoch. The two values come from two separate `/epochs/latest/parameters`
// HTTP calls; if a Cardano epoch boundary lands between them, one returns
// epoch N and the other N+1, producing mismatched cost models vs protocol
// params -> the resulting script_data_hash is rejected with
// PPViewHashesDontMatch for the whole CACHE_TTL_MS window. Epoch boundaries
// are days apart, so a single retry closes the window in practice; cap at 3
// so a pathological boundary-storm can't loop forever.
const EPOCH_STRADDLE_MAX_ATTEMPTS = 3;

async function fetchAndPatch(blockfrostApiKey: string): Promise<unknown> {
	const api = new BlockFrostAPI({ projectId: blockfrostApiKey });
	// Fetch in parallel: BlockFrostAPI gives raw cost_models we need to mutate
	// mesh's static arrays, and the cached `BlockfrostProvider` (one per API
	// key, see `getCachedBlockfrostProvider`) returns the mesh-format Protocol
	// object that `MeshTxBuilder.protocolParams(...)` accepts. Caching both
	// alongside the cost-model sync means callers don't pay a second roundtrip
	// to `/epochs/latest/parameters` on every tx build.
	//
	// Epoch-straddle guard: the cost models (from `rawResponse`) and the mesh
	// Protocol (from the provider) are two independent requests. If an epoch
	// boundary falls between them they can disagree by one epoch. Both requests
	// resolve `/epochs/latest/parameters`, whose payload carries `.epoch`, so
	// after fetching we re-read the latest epoch and, if it advanced past the
	// epoch the cost-models response reported, discard the pair and retry. This
	// guarantees the cached cost-models + protocol-params pair is internally
	// consistent (same epoch) before it is applied to the process-global arrays.
	const provider = getCachedBlockfrostProvider(blockfrostApiKey);

	let rawResponse: {
		epoch?: number | null;
		cost_models_raw?: { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown } | null;
	} | null = null;
	let meshProtocol: unknown = null;

	for (let attempt = 1; attempt <= EPOCH_STRADDLE_MAX_ATTEMPTS; attempt++) {
		const [fetchedRaw, fetchedProtocol] = await Promise.all([
			api.epochsLatestParameters() as unknown as Promise<{
				epoch?: number | null;
				cost_models_raw?: { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown } | null;
			}>,
			// NaN routes to `/epochs/latest/parameters` in the BlockfrostProvider
			// impl (any real epoch number would hit `/epochs/<n>/parameters`).
			provider.fetchProtocolParameters(Number.NaN),
		]);

		// Re-read the latest epoch AFTER both fetches resolved. If it still
		// equals the epoch the cost-models response reported, no boundary was
		// crossed during the pair and the two values are consistent.
		const epochCheck = (await api.epochsLatestParameters()) as unknown as { epoch?: number | null };
		const fetchedEpoch = fetchedRaw?.epoch;
		const currentEpoch = epochCheck?.epoch;

		if (fetchedEpoch == null || currentEpoch == null || fetchedEpoch === currentEpoch) {
			// Consistent (or epoch unavailable to compare — accept rather than
			// loop forever; the prior behavior had no check at all).
			rawResponse = fetchedRaw;
			meshProtocol = fetchedProtocol;
			break;
		}

		logger.warn('Mesh cost-model sync straddled an epoch boundary; retrying for a consistent snapshot', {
			fetchedEpoch,
			currentEpoch,
			attempt,
			maxAttempts: EPOCH_STRADDLE_MAX_ATTEMPTS,
		});

		if (attempt === EPOCH_STRADDLE_MAX_ATTEMPTS) {
			// Exhausted retries — use the latest pair anyway. Re-fetch both once
			// more so cost models and protocol params at least come from calls
			// made after the last observed boundary; logged above so operators
			// can see the (very rare) straddle storm.
			const [finalRaw, finalProtocol] = await Promise.all([
				api.epochsLatestParameters() as unknown as Promise<{
					epoch?: number | null;
					cost_models_raw?: { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown } | null;
				}>,
				provider.fetchProtocolParameters(Number.NaN),
			]);
			rawResponse = finalRaw;
			meshProtocol = finalProtocol;
		}
	}

	const raw = rawResponse?.cost_models_raw;
	if (!raw) {
		logger.warn(
			'Blockfrost did not return cost_models_raw; mesh-sdk bundled cost models left in place. ' +
				'Plutus tx submissions may fail with PPViewHashesDontMatch if the chain has rotated cost models.',
		);
	} else {
		// Cache the raw payload so V2-pinned consumers can patch their own
		// mesh-sdk cost-model arrays (separate npm install, separate globals)
		// without re-fetching from Blockfrost.
		lastRawCostModelsByKey.set(blockfrostApiKey, raw);

		const v1Patched = replaceListInPlace(DEFAULT_V1_COST_MODEL_LIST, raw.PlutusV1);
		const v2Patched = replaceListInPlace(DEFAULT_V2_COST_MODEL_LIST, raw.PlutusV2);
		const v3Patched = replaceListInPlace(DEFAULT_V3_COST_MODEL_LIST, raw.PlutusV3);

		logger.info('Synced mesh-sdk Plutus cost models from chain (V1 mesh line)', {
			v1: v1Patched,
			v2: v2Patched,
			v3: v3Patched,
			v1Length: DEFAULT_V1_COST_MODEL_LIST.length,
			v2Length: DEFAULT_V2_COST_MODEL_LIST.length,
			v3Length: DEFAULT_V3_COST_MODEL_LIST.length,
		});
	}

	return meshProtocol;
}

// Singleton BlockfrostProvider per API key. Multiple services + tx builders
// used to each instantiate their own `new BlockfrostProvider(apiKey)`, which
// gave each one its own internal cache and burned extra connections under
// load. Reusing one instance also keeps the chain-params cache (below)
// consistent with whatever the builder uses for its own internal calls.
const providerCache = new Map<string, BlockfrostProvider>();
export function getCachedBlockfrostProvider(blockfrostApiKey: string): BlockfrostProvider {
	let provider = providerCache.get(blockfrostApiKey);
	if (provider == null) {
		provider = new BlockfrostProvider(blockfrostApiKey);
		providerCache.set(blockfrostApiKey, provider);
	}
	return provider;
}

/**
 * Return the most recently cached mesh-format protocol parameters for this
 * API key, or `null` if the cache is empty or expired. Callers should fall
 * back to a live fetch when this returns `null` — typically that means the
 * very first tx build of the process lifetime.
 */
export function getCachedChainProtocolParameters(blockfrostApiKey: string): unknown {
	const cached = lastSyncByKey.get(blockfrostApiKey);
	if (cached == null) return null;
	if (Date.now() - cached.at >= CACHE_TTL_MS) return null;
	return cached.protocolParameters;
}

/**
 * Ensure mesh-sdk's bundled Plutus cost-model arrays reflect the chain's
 * current `cost_models_raw`, and refresh the cached mesh-format protocol
 * parameters at the same time. Safe to call before every tx build — memoized
 * for {@link CACHE_TTL_MS} so we don't hammer Blockfrost.
 *
 * Pass `forceRefresh: true` to bypass the cache, e.g. after a
 * PPViewHashesDontMatch retry.
 *
 * Returns the cached mesh Protocol object so callers can pass it straight
 * into `MeshTxBuilder.protocolParams(...)` without a second fetch.
 */
export async function syncMeshCostModelsFromChain(
	blockfrostApiKey: string,
	options: { forceRefresh?: boolean } = {},
): Promise<unknown> {
	return await withCostModelLock(() => syncChainModelsLocked(blockfrostApiKey, options));
}

async function syncChainModelsLocked(blockfrostApiKey: string, options: { forceRefresh?: boolean }): Promise<unknown> {
	const now = Date.now();
	const cached = lastSyncByKey.get(blockfrostApiKey);
	if (!options.forceRefresh && cached != null && now - cached.at < CACHE_TTL_MS) {
		// A different provider or head may have replaced the global arrays.
		const raw = getCachedRawCostModels(blockfrostApiKey);
		if (raw != null) {
			replaceListInPlace(DEFAULT_V1_COST_MODEL_LIST, raw.PlutusV1);
			replaceListInPlace(DEFAULT_V2_COST_MODEL_LIST, raw.PlutusV2);
			replaceListInPlace(DEFAULT_V3_COST_MODEL_LIST, raw.PlutusV3);
		}
		return cached.protocolParameters;
	}
	const existing = inFlightByKey.get(blockfrostApiKey);
	if (existing != null) {
		// Same-key concurrent caller: piggy-back on the running fetch.
		// Different-key callers do NOT enter this branch — each key has its
		// own in-flight slot, so concurrent multi-network syncs run in
		// parallel rather than one stealing the other's result.
		return await existing;
	}
	const promise = (async () => {
		try {
			const protocolParameters = await fetchAndPatch(blockfrostApiKey);
			lastSyncByKey.set(blockfrostApiKey, { protocolParameters, at: Date.now() });
			return protocolParameters;
		} catch (error) {
			// Re-throw so the caller (typically a scheduler) can log and abort
			// the current tx build. Silently returning null left the mesh cost
			// model arrays unpatched, which surfaces downstream as
			// `PPViewHashesDontMatch` when the tx is submitted.
			logger.error('Failed to sync mesh-sdk cost models from chain', { error });
			throw error;
		} finally {
			inFlightByKey.delete(blockfrostApiKey);
		}
	})();
	inFlightByKey.set(blockfrostApiKey, promise);
	return await promise;
}
