import { Prisma } from '@/generated/prisma/client';

export type FundTransferAsset = { unit: string; quantity: bigint };

/**
 * Turn a stored transfer into the asset list the builder sends: the validated
 * `lovelaceAmount` first, then any native tokens from the `assets` Json column.
 *
 * The column is validated on write by `postWalletFundSchemaInput` (the only
 * writer), so entries are well-formed. This still parses defensively — reading
 * each element's fields explicitly rather than casting the Json blob to a typed
 * array — because a malformed row must not reach `sendAssets` and produce a
 * wrong on-chain value. A `lovelace` entry inside `assets` is ignored: ADA is
 * carried solely by `lovelaceAmount`, and mesh's value assembler would drop a
 * duplicate lovelace entry silently anyway.
 */
export function readFundTransferAssets(lovelaceAmount: bigint, assets: Prisma.JsonValue | null): FundTransferAsset[] {
	const result: FundTransferAsset[] = [{ unit: 'lovelace', quantity: lovelaceAmount }];

	if (!Array.isArray(assets)) return result;

	for (const entry of assets) {
		if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) continue;
		const unit = (entry as { unit?: unknown }).unit;
		const quantity = (entry as { quantity?: unknown }).quantity;
		if (typeof unit !== 'string' || unit === 'lovelace' || unit === '') continue;
		if (typeof quantity !== 'string' || !/^[1-9][0-9]*$/.test(quantity)) continue;
		result.push({ unit, quantity: BigInt(quantity) });
	}

	return result;
}
