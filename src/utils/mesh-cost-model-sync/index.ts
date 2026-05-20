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
// ledger uses; no need to re-derive ordering. The sync is memoized per
// process for {@link CACHE_TTL_MS} so we do not hammer Blockfrost.
//
// Long-term fix: upstream PR to mesh-sdk to expose a cost-model setter on
// MeshTxBuilder, or migrate off mesh-sdk for tx building.

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
// `@meshsdk/core` re-exports `@meshsdk/common`'s symbols (`export * from
// '@meshsdk/common'`), so we can import from core to avoid adding
// `@meshsdk/common` as a direct workspace dep. The arrays we mutate ARE the
// same references mesh's internal hashScriptData uses — JS modules give us a
// live binding to the array object, not a copy.
import { DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST } from '@meshsdk/core';
import { logger } from '@/utils/logger';

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
type CachedSync = {
	at: number;
};

const inFlightByKey = new Map<string, Promise<void>>();
const lastSyncByKey = new Map<string, CachedSync>();

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

async function fetchAndPatch(blockfrostApiKey: string): Promise<void> {
	const api = new BlockFrostAPI({ projectId: blockfrostApiKey });
	const params = (await api.epochsLatestParameters()) as unknown as {
		cost_models_raw?: { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown } | null;
	};
	const raw = params?.cost_models_raw;
	if (!raw) {
		logger.warn(
			'Blockfrost did not return cost_models_raw; mesh-sdk bundled cost models left in place. ' +
				'Plutus tx submissions may fail with PPViewHashesDontMatch if the chain has rotated cost models.',
		);
		return;
	}

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

/**
 * Ensure mesh-sdk's bundled Plutus cost-model arrays reflect the chain's
 * current `cost_models_raw`. Safe to call before every tx build — memoized
 * for {@link CACHE_TTL_MS} so we don't hammer Blockfrost.
 *
 * Pass `forceRefresh: true` to bypass the cache, e.g. after a
 * PPViewHashesDontMatch retry.
 */
export async function syncMeshCostModelsFromChain(
	blockfrostApiKey: string,
	options: { forceRefresh?: boolean } = {},
): Promise<void> {
	const now = Date.now();
	const cached = lastSyncByKey.get(blockfrostApiKey);
	if (!options.forceRefresh && cached != null && now - cached.at < CACHE_TTL_MS) {
		return;
	}
	const existing = inFlightByKey.get(blockfrostApiKey);
	if (existing != null) {
		// Same-key concurrent caller: piggy-back on the running fetch.
		// Different-key callers do NOT enter this branch — each key has its
		// own in-flight slot, so concurrent multi-network syncs run in
		// parallel rather than one stealing the other's result.
		await existing;
		return;
	}
	const promise = (async () => {
		try {
			await fetchAndPatch(blockfrostApiKey);
			lastSyncByKey.set(blockfrostApiKey, { at: Date.now() });
		} catch (error) {
			logger.error('Failed to sync mesh-sdk cost models from chain', { error });
		} finally {
			inFlightByKey.delete(blockfrostApiKey);
		}
	})();
	inFlightByKey.set(blockfrostApiKey, promise);
	await promise;
}
