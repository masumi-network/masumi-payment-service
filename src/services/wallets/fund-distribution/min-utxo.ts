import {
	Address,
	AssetName,
	BigNum,
	DataCost,
	MultiAsset,
	ScriptHash,
	TransactionOutputBuilder,
	Value,
} from '@emurgo/cardano-serialization-lib-nodejs';
import { CONSTANTS } from '@masumi/payment-core/config';
import { logger } from '@masumi/payment-core/logger';
import { getCachedBlockfrostProvider } from '@/utils/mesh-cost-model-sync';

export type DistributionOutputAsset = {
	unit: string;
	quantity: bigint;
};

export type DistributionProtocolParameters = {
	coinsPerUtxoSize: number;
	maxValueSize: number;
};

/**
 * Load the current ledger limits used for min-UTxO and Value size. Falling back
 * is safe: the root fallbacks track the current Cardano parameters and the
 * transaction builder still validates the output before broadcast.
 */
export async function getDistributionProtocolParameters(
	rpcProviderApiKey: string,
): Promise<DistributionProtocolParameters> {
	try {
		const protocolParameters = await getCachedBlockfrostProvider(rpcProviderApiKey).fetchProtocolParameters();
		const coinsPerUtxoSize = protocolParameters.coinsPerUtxoSize;
		const maxValueSize = protocolParameters.maxValSize;
		if (
			Number.isFinite(coinsPerUtxoSize) &&
			coinsPerUtxoSize > 0 &&
			Number.isFinite(maxValueSize) &&
			maxValueSize > 0
		) {
			return { coinsPerUtxoSize, maxValueSize };
		}
	} catch (error) {
		logger.warn('Failed to load protocol parameters for fund distribution output calculation', {
			component: 'fund_distribution',
			error: error instanceof Error ? error.message : String(error),
			fallback_coins_per_utxo_size: CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE,
			fallback_max_value_size: CONSTANTS.FALLBACK_MAX_VALUE_SIZE,
		});
	}

	return {
		coinsPerUtxoSize: CONSTANTS.FALLBACK_COINS_PER_UTXO_SIZE,
		maxValueSize: CONSTANTS.FALLBACK_MAX_VALUE_SIZE,
	};
}

export async function getDistributionCoinsPerUtxoSize(rpcProviderApiKey: string): Promise<number> {
	return (await getDistributionProtocolParameters(rpcProviderApiKey)).coinsPerUtxoSize;
}

function buildDistributionMultiAsset(assets: DistributionOutputAsset[]): MultiAsset {
	const multiAsset = MultiAsset.new();

	for (const asset of assets) {
		if (asset.unit === 'lovelace') continue;
		const policyId = ScriptHash.from_bytes(Buffer.from(asset.unit.slice(0, 56), 'hex'));
		const assetName = AssetName.new(Buffer.from(asset.unit.slice(56), 'hex'));
		multiAsset.set_asset(policyId, assetName, BigNum.from_str(asset.quantity.toString()));
	}

	return multiAsset;
}

export function calculateDistributionValueSize(assets: DistributionOutputAsset[]): number {
	const value = Value.new(
		BigNum.from_str((assets.find((asset) => asset.unit === 'lovelace')?.quantity ?? 0n).toString()),
	);
	const multiAsset = buildDistributionMultiAsset(assets);
	if (multiAsset.len() > 0) value.set_multiasset(multiAsset);
	return value.to_bytes().length;
}

/**
 * Calculate the ledger-required lovelace for a plain native-token output.
 *
 * CSL serializes the actual address and multiasset value, then applies the
 * active coins-per-UTxO-byte cost. This grows with policy count and asset-name
 * size, unlike a fixed ADA floor.
 */
export function calculateDistributionMinLovelace(params: {
	address: string;
	assets: DistributionOutputAsset[];
	coinsPerUtxoSize: number;
}): bigint {
	const { address, assets, coinsPerUtxoSize } = params;
	const multiAsset = buildDistributionMultiAsset(assets);

	if (multiAsset.len() === 0) return 0n;

	const output = TransactionOutputBuilder.new()
		.with_address(Address.from_bech32(address))
		.next()
		.with_asset_and_min_required_coin_by_utxo_cost(
			multiAsset,
			DataCost.new_coins_per_byte(BigNum.from_str(coinsPerUtxoSize.toString())),
		)
		.build();

	return BigInt(output.amount().coin().to_str());
}
