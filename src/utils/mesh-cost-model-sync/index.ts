// Sync mesh-sdk's bundled Plutus cost models with what the chain actually
// uses. This is a workaround for an upstream gap in @meshsdk/core
// 1.9.0-beta.96 (and identical in .102): MeshTxBuilder hardcodes the imported
// DEFAULT_V*_COST_MODEL_LIST arrays into hashScriptData(), and the Protocol
// type accepted by `.protocolParams(...)` has no cost-model fields, so there
// is no public API to inject chain-current cost models.
//
// Symptom when out of date: ledger rejects submission with
//   ConwayUtxowFailure (PPViewHashesDontMatch ...)
// because mesh's locally-computed script_data_hash uses stale cost models
// while the ledger recomputes from the live on-chain cost models.
//
// Trick: the lists are exported as mutable arrays from `@meshsdk/common` and
// referenced by `@meshsdk/core-cst`'s hash function via the same import. JS
// arrays are passed by reference, so mutating the array in place (clearing it
// and pushing chain values) updates what mesh sees from the next tx build on.
//
// We pull `cost_models_raw` from Blockfrost's `/epochs/latest/parameters`
// because that is already the canonical ordered list the ledger uses; no need
// to re-derive ordering. The sync is memoized per-process and refreshes when
// `forceRefresh` is requested (e.g. on a tx submission failure that suggests
// the cost models rotated mid-process).
//
// Long-term fix: upstream PR to mesh-sdk to expose a cost-model setter on
// MeshTxBuilder. Track in docs/adr if/when that lands.

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
// `@meshsdk/core` re-exports `@meshsdk/common`'s symbols (`export * from
// '@meshsdk/common'`), so we import from core to avoid needing to add
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
	blockfrostApiKey: string;
	protocolParameters: unknown;
	at: number;
};

let inFlight: Promise<unknown> | null = null;
let lastSync: CachedSync | null = null;

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

async function fetchAndPatch(blockfrostApiKey: string): Promise<unknown> {
	const api = new BlockFrostAPI({ projectId: blockfrostApiKey });
	// Fetch in parallel: BlockFrostAPI gives raw cost_models we need to mutate
	// mesh's static arrays, and the cached `BlockfrostProvider` (one per API
	// key, see `getCachedBlockfrostProvider`) returns the mesh-format Protocol
	// object that `MeshTxBuilder.protocolParams(...)` accepts. Caching both
	// alongside the cost-model sync means callers don't pay a second roundtrip
	// to `/epochs/latest/parameters` on every tx build.
	const provider = getCachedBlockfrostProvider(blockfrostApiKey);
	const [rawResponse, meshProtocol] = await Promise.all([
		api.epochsLatestParameters() as unknown as Promise<{
			cost_models_raw?: { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown } | null;
		}>,
		// NaN routes to `/epochs/latest/parameters` in the BlockfrostProvider
		// impl (any real epoch number would hit `/epochs/<n>/parameters`).
		provider.fetchProtocolParameters(Number.NaN),
	]);

	const raw = rawResponse?.cost_models_raw;
	if (!raw) {
		logger.warn(
			'Blockfrost did not return cost_models_raw; mesh-sdk bundled cost models left in place. ' +
				'Plutus tx submissions may fail with PPViewHashesDontMatch if the chain has rotated cost models.',
		);
	} else {
		const v1Patched = replaceListInPlace(DEFAULT_V1_COST_MODEL_LIST, raw.PlutusV1);
		const v2Patched = replaceListInPlace(DEFAULT_V2_COST_MODEL_LIST, raw.PlutusV2);
		const v3Patched = replaceListInPlace(DEFAULT_V3_COST_MODEL_LIST, raw.PlutusV3);

		logger.info('Synced mesh-sdk Plutus cost models from chain', {
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
	if (lastSync == null) return null;
	if (lastSync.blockfrostApiKey !== blockfrostApiKey) return null;
	if (Date.now() - lastSync.at >= CACHE_TTL_MS) return null;
	return lastSync.protocolParameters;
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
	const now = Date.now();
	if (
		!options.forceRefresh &&
		lastSync != null &&
		lastSync.blockfrostApiKey === blockfrostApiKey &&
		now - lastSync.at < CACHE_TTL_MS
	) {
		return lastSync.protocolParameters;
	}
	if (inFlight != null) {
		// In-flight refresh wins; await its result rather than starting a
		// duplicate fetch (any caller racing for the same key gets the same
		// promise).
		return await inFlight;
	}
	inFlight = (async () => {
		try {
			const protocolParameters = await fetchAndPatch(blockfrostApiKey);
			lastSync = { blockfrostApiKey, protocolParameters, at: Date.now() };
			return protocolParameters;
		} catch (error) {
			logger.error('Failed to sync mesh-sdk cost models from chain', { error });
			// Surface a soft failure: caller can still fall through to its own
			// `provider.fetchProtocolParameters(NaN)` path.
			return null;
		} finally {
			inFlight = null;
		}
	})();
	return await inFlight;
}
