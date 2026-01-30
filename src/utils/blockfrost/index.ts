// Cache BlockFrostAPI instances to prevent memory leaks from repeated instantiation

import { BlockFrostAPI } from '@blockfrost/blockfrost-js';
import { $Enums } from '@/generated/prisma/client';
import { logger } from '@/utils/logger';

// Key format: `${network}-${apiKey}`
const blockfrostInstanceCache = new Map<string, BlockFrostAPI>();

export type InvalidAsset = {
	asset: string;
	errorMessage: string;
};

export function getBlockfrostInstance(network: $Enums.Network, apiKey: string): BlockFrostAPI {
	const cacheKey = `${network}-${apiKey}`;
	let instance = blockfrostInstanceCache.get(cacheKey);

	if (!instance) {
		instance = new BlockFrostAPI({
			projectId: apiKey,
			network: network === $Enums.Network.Mainnet ? 'mainnet' : 'preprod',
		});
		blockfrostInstanceCache.set(cacheKey, instance);
		logger.info('Created new BlockFrostAPI instance', { network });
	}

	return instance;
}

/**
 * Validates that assets exist on-chain using Blockfrost.
 * Skips ADA/lovelace (empty string or "lovelace").
 *
 * @param blockfrost - BlockFrostAPI instance
 * @param assetUnits - Array of asset units to validate (policyId + assetName in hex)
 * @returns Object containing arrays of valid and invalid assets
 */
export async function validateAssetsOnChain(
	blockfrost: BlockFrostAPI,
	assetUnits: string[],
): Promise<{
	valid: string[];
	invalid: InvalidAsset[];
}> {
	const validAssets: string[] = [];
	const invalidAssets: InvalidAsset[] = [];

	// Validate all assets in parallel for better performance
	const validationResults = await Promise.allSettled(
		assetUnits.map(async (unit) => {
			const normalizedUnit = unit.toLowerCase();

			// Skip ADA/lovelace (empty string or "lovelace")
			if (normalizedUnit === '' || normalizedUnit === 'lovelace') {
				return { unit, valid: true };
			}

			// Validate format: must be policyId + assetName in hex (at least 56 chars)
			if (!/^[a-f0-9]{56,}$/i.test(unit)) {
				return {
					unit,
					valid: false,
					reason: 'invalid format - must be policyId + assetName in hex',
				};
			}

			// Check if asset exists on-chain
			try {
				await blockfrost.assetsById(unit);
				return { unit, valid: true };
			} catch (error) {
				if (
					error instanceof Error &&
					(error.message.includes('404') ||
						error.message.toLocaleLowerCase().includes('not found') ||
						error.message.toLocaleLowerCase().includes('not been found'))
				) {
					return {
						unit,
						valid: false,
						reason: 'asset not found on-chain',
					};
				}
				// Treat network/server errors as invalid assets
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				return {
					unit,
					valid: false,
					reason: `validation error: ${errorMessage}`,
				};
			}
		}),
	);

	// Process results and collect valid and invalid assets
	for (let i = 0; i < validationResults.length; i++) {
		const result = validationResults[i];

		if (result.status === 'rejected') {
			// Treat rejected promises as invalid assets
			const unit = assetUnits[i];
			if (!unit) {
				continue; // Skip if unit is somehow undefined
			}
			const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
			invalidAssets.push({
				asset: unit,
				errorMessage: `validation error: ${errorMessage}`,
			});
			continue;
		}

		const validation = result.value;
		if (validation.valid) {
			validAssets.push(validation.unit);
		} else {
			invalidAssets.push({
				asset: validation.unit,
				errorMessage: validation.reason ?? 'Unknown validation error',
			});
		}
	}

	return { valid: validAssets, invalid: invalidAssets };
}
