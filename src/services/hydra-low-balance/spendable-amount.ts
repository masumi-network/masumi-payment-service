import type { HydraHeadOwnBalance } from '@/services/hydra-connection-manager/hydra-head-balance';

/** Rule `assetUnit` uses 'lovelace'; the balance snapshot keys ADA as ''. */
function balanceKeyForAssetUnit(assetUnit: string): string {
	const normalized = assetUnit.toLowerCase();
	return normalized === 'lovelace' ? '' : normalized;
}

/** The rule's asset in the spendable in-head balance; zero when the head holds none. */
export function spendableAmountOf(balance: Pick<HydraHeadOwnBalance, 'spendableBalance'>, assetUnit: string): bigint {
	const key = balanceKeyForAssetUnit(assetUnit);
	return BigInt(balance.spendableBalance.find((asset) => asset.unit.toLowerCase() === key)?.quantity ?? '0');
}
