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
import { Mutex } from 'async-mutex';
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

// In-flight syncs and last successful sync are tracked per Blockfrost API key.
// A single global slot would incorrectly coalesce concurrent calls from
// different networks (e.g. mainnet + preprod processed in parallel via
// Promise.allSettled): the second caller would await the first caller's fetch
// and return without ever syncing its own cost models, leaving the global
// arrays holding the wrong network's values for that caller's tx build. Note:
// the mutated DEFAULT_V*_COST_MODEL_LIST arrays are STILL process-global —
// the per-key tracking only fixes the "did we sync at all" question; if two
// networks alternate, the arrays are last-writer-wins. Single-network
// deployments are unaffected.
//
// DEPLOYMENT REQUIREMENT (multi-network):
// Because the mutated arrays are process-global, single-process deployments
// that serve more than one Cardano network (mainnet + preprod) have a race
// window between a sync for network A and a tx build for network B: A's
// sync can overwrite the cost-model arrays mid-build for B, corrupting
// B's `script_data_hash` and producing intermittent `PPViewHashesDontMatch`
// errors at submission. Mitigations, in order of preference:
//
//  1. Run mainnet and preprod in separate processes (recommended for
//     production). Process-global is then naturally per-network and no
//     race exists. Most operational setups already deploy this way.
//  2. If a single-process multi-network deployment is required, the
//     operator must accept that under contention `PPViewHashesDontMatch`
//     submissions will retry via the standard retry path (a corrupted
//     build re-queues and re-syncs on the next tick). This is correct
//     but wastes fees and adds latency under sustained cross-network
//     load.
//
// Same-paymentSource serialization: a per-rpcApiKey mutex (see
// `withMeshCostModelLock` below) wraps sync + build + sign so two builds
// using the SAME payment-source's cost-model arrays cannot interleave.
// This closes the race between (a) call N+1's sync reading
// `lastSyncByKey` as cached and skipping the patch, while call N is still
// in the middle of its `txBuilder.complete()` that captured the array
// reference; and (b) any direct mutation of the global lists between
// build and sign. Cross-paymentSource (different rpcApiKey) builds remain
// parallel and are safe IFF they target the same network — which is the
// supported single-process deployment shape (see DEPLOYMENT REQUIREMENT
// above). Cross-NETWORK single-process is still last-writer-wins on the
// globals; redeploy with one process per network for that case.
const inFlightByKey = new Map<string, Promise<unknown>>();
const lastSyncByKey = new Map<string, CachedSync>();

// Per-rpcApiKey async mutex. `Mutex` from `async-mutex` is FIFO and
// reentrant-unsafe (don't call `withMeshCostModelLock` again inside its
// own closure for the same key — it will deadlock). rpcApiKey is unique
// per PaymentSource, so this is equivalent to per-paymentSourceId
// keying. Storing the Mutex objects on the module is intentional: same
// process, same lifetime as the cost-model globals they protect.
const buildMutexByKey = new Map<string, Mutex>();
function getBuildMutex(blockfrostApiKey: string): Mutex {
	let mutex = buildMutexByKey.get(blockfrostApiKey);
	if (mutex == null) {
		mutex = new Mutex();
		buildMutexByKey.set(blockfrostApiKey, mutex);
	}
	return mutex;
}

/**
 * Serialize cost-model sync + tx build + sign for a given payment source
 * (keyed by Blockfrost API key, which is unique per PaymentSource).
 *
 * Callers MUST wrap the WHOLE block that depends on the synced cost
 * models — including `syncMeshCostModelsFromChain(...)` AND the
 * subsequent `txBuilder.complete()` / `wallet.signTx(...)`. Releasing
 * the mutex any earlier reintroduces the race window.
 *
 * Holding the mutex through `signTx` is sufficient because mesh's
 * internal hashScriptData captures the cost-model arrays at
 * `complete()` time; once the tx is signed, the script_data_hash is
 * baked into the signed body and subsequent global mutations do not
 * affect it. `submitTx` is OUTSIDE the critical section.
 */
export async function withMeshCostModelLock<T>(blockfrostApiKey: string, operation: () => Promise<T>): Promise<T> {
	return await getBuildMutex(blockfrostApiKey).runExclusive(operation);
}

/**
 * Acquire-and-return-release variant of {@link withMeshCostModelLock}.
 *
 * Use this when the build / sign critical section spans multiple
 * try/catch blocks that don't fit cleanly inside a single closure. The
 * caller is responsible for ALWAYS calling the returned `release()`
 * function (use `try/finally`). The release is idempotent — calling it
 * twice is a no-op — but forgetting to call it strands the mutex
 * indefinitely.
 *
 * Prefer `withMeshCostModelLock(...)` (closure form) where the critical
 * section can be expressed as one async function — it cannot leak the
 * lock on error.
 *
 * Example:
 *
 *   const release = await acquireMeshCostModelLock(apiKey);
 *   try {
 *     const unsignedTx = await generateMasumiSmartContract...(...);
 *     const signedTx = await wallet.signTx(unsignedTx);
 *     // ... post-sign work, intent recording, etc. — release first
 *   } finally {
 *     release();
 *   }
 *   // submitTx OUTSIDE the lock
 */
export async function acquireMeshCostModelLock(blockfrostApiKey: string): Promise<() => void> {
	const release = await getBuildMutex(blockfrostApiKey).acquire();
	let released = false;
	return () => {
		if (released) return;
		released = true;
		release();
	};
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
 * sync-or-skip decision based on `lastSyncByKey`).
 */
type RawCostModels = { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown };
const lastRawCostModelsByKey = new Map<string, RawCostModels>();

export function getCachedRawCostModels(blockfrostApiKey: string): RawCostModels | null {
	return lastRawCostModelsByKey.get(blockfrostApiKey) ?? null;
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
	const now = Date.now();
	const cached = lastSyncByKey.get(blockfrostApiKey);
	if (!options.forceRefresh && cached != null && now - cached.at < CACHE_TTL_MS) {
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
