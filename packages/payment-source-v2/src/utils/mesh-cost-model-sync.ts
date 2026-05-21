// V2-pinned cost-model sync. The shared helper at
// `src/utils/mesh-cost-model-sync/index.ts` is V1-pinned (it lives under
// `src/`, which the root manifest resolves to `@meshsdk/core@1.9.0-beta.96`).
// V2 mesh-sdk (1.9.0-beta.102, installed under
// `packages/payment-source-v2/node_modules/@meshsdk/core`) has its OWN
// bundled `DEFAULT_V*_COST_MODEL_LIST` arrays, so patching the V1 ones leaves
// V2's stale and every V2 Plutus tx will hit
// `PPViewHashesDontMatch` until those arrays are also overwritten.
//
// Strategy: re-use the shared sync helper to fetch + cache the raw payload
// once per API key (cheap roundtrip, memoized 5 min), then apply that payload
// to THIS file's import of `DEFAULT_V*_COST_MODEL_LIST` — which, by virtue of
// living in `packages/payment-source-v2/src/...`, resolves to the V2 mesh
// line.
//
// V2 builders should call this helper BEFORE any tx build. The shared sync
// helper continues to drive V1 codepaths.

import { DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST } from '@meshsdk/core';
import { logger } from '@masumi/payment-core/logger';
import {
	getCachedRawCostModels,
	syncMeshCostModelsFromChain as syncSharedMeshCostModels,
} from '@/utils/mesh-cost-model-sync';

function replaceListInPlace(target: number[], next: unknown): boolean {
	if (!Array.isArray(next)) return false;
	const cleaned: number[] = [];
	for (const value of next) {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) return false;
		cleaned.push(numeric);
	}
	target.length = 0;
	for (const value of cleaned) {
		target.push(value);
	}
	return true;
}

const TTL_MS = 5 * 60 * 1000;
type V2SyncMarker = { at: number };
const lastV2SyncByKey = new Map<string, V2SyncMarker>();

/**
 * Sync the V2 mesh-sdk's bundled Plutus cost-model arrays with chain. Reuses
 * the shared helper's Blockfrost fetch + cache (so V1 + V2 share one
 * roundtrip per API key per TTL). Always returns the shared helper's
 * mesh-format Protocol object — V1 callers were already passing that into
 * `MeshTxBuilder.protocolParams(...)`, and the V2 mesh line's
 * `protocolParams(...)` accepts the same runtime shape (the type difference
 * is purely nominal across the two beta versions).
 *
 * Pass `forceRefresh: true` after a `PPViewHashesDontMatch` retry to skip
 * the TTL cache.
 */
export async function syncMeshCostModelsFromChainV2(
	blockfrostApiKey: string,
	options: { forceRefresh?: boolean } = {},
): Promise<unknown> {
	// First, ensure the shared helper has run for this key — that's what
	// populates `getCachedRawCostModels(...)`. Side effect: V1 arrays get
	// patched too. That's harmless (V1 codepaths use them) and avoids a
	// second Blockfrost roundtrip from the V2 side.
	const sharedProtocol = await syncSharedMeshCostModels(blockfrostApiKey, options);

	const now = Date.now();
	const lastV2 = lastV2SyncByKey.get(blockfrostApiKey);
	if (!options.forceRefresh && lastV2 != null && now - lastV2.at < TTL_MS) {
		return sharedProtocol;
	}

	const raw = getCachedRawCostModels(blockfrostApiKey);
	if (raw == null) {
		// Shared sync didn't populate (blockfrost outage, or `cost_models_raw`
		// missing). Surface a soft warning — V2 mesh stays on its bundled
		// defaults and may hit PPViewHashesDontMatch.
		logger.warn(
			'V2 cost-model sync skipped: shared helper has no cached raw cost models. ' +
				'V2 Plutus tx submissions may fail with PPViewHashesDontMatch.',
		);
		return sharedProtocol;
	}

	const v1Patched = replaceListInPlace(DEFAULT_V1_COST_MODEL_LIST, raw.PlutusV1);
	const v2Patched = replaceListInPlace(DEFAULT_V2_COST_MODEL_LIST, raw.PlutusV2);
	const v3Patched = replaceListInPlace(DEFAULT_V3_COST_MODEL_LIST, raw.PlutusV3);

	logger.info('Synced mesh-sdk Plutus cost models from chain (V2 mesh line)', {
		v1: v1Patched,
		v2: v2Patched,
		v3: v3Patched,
		v1Length: DEFAULT_V1_COST_MODEL_LIST.length,
		v2Length: DEFAULT_V2_COST_MODEL_LIST.length,
		v3Length: DEFAULT_V3_COST_MODEL_LIST.length,
	});

	lastV2SyncByKey.set(blockfrostApiKey, { at: now });
	return sharedProtocol;
}
