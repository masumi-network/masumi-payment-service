// Sync mesh-sdk's bundled Plutus cost models with what the chain actually
// uses. MeshTxBuilder hashes script data against static DEFAULT_V*_COST_MODEL_LIST
// arrays; after Cardano protocol parameter updates those bundled values can go
// stale and submissions fail with PPViewHashesDontMatch.

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { DEFAULT_V1_COST_MODEL_LIST, DEFAULT_V2_COST_MODEL_LIST, DEFAULT_V3_COST_MODEL_LIST } from '@meshsdk/core';
import { logger } from '@/utils/logger';

type CachedSync = {
	blockfrostApiKey: string;
	at: number;
};

const inFlightByKey = new Map<string, Promise<void>>();
const lastSyncByKey = new Map<string, CachedSync>();

const CACHE_TTL_MS = 5 * 60 * 1000;

function replaceListInPlace(target: number[], next: unknown): boolean {
	if (!Array.isArray(next)) return false;
	const cleaned: number[] = [];
	for (const value of next) {
		const numeric = typeof value === 'number' ? value : Number(value);
		if (!Number.isFinite(numeric)) return false;
		cleaned.push(numeric);
	}
	target.splice(0, target.length, ...cleaned);
	return true;
}

async function fetchAndPatch(blockfrostApiKey: string): Promise<void> {
	const api = new BlockFrostAPI({ projectId: blockfrostApiKey });
	const params = (await api.epochsLatestParameters()) as unknown as {
		cost_models_raw?: { PlutusV1?: unknown; PlutusV2?: unknown; PlutusV3?: unknown } | null;
	};
	const raw = params.cost_models_raw;

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
		await existing;
		return;
	}

	const promise = (async () => {
		try {
			await fetchAndPatch(blockfrostApiKey);
			lastSyncByKey.set(blockfrostApiKey, { blockfrostApiKey, at: Date.now() });
		} catch (error) {
			logger.error('Failed to sync mesh-sdk cost models from chain', { error });
			throw error;
		} finally {
			inFlightByKey.delete(blockfrostApiKey);
		}
	})();
	inFlightByKey.set(blockfrostApiKey, promise);
	await promise;
}
