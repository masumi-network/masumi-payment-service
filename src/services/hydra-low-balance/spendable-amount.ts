import type { HydraHeadOwnBalance } from '@/services/hydra-connection-manager/hydra-head-balance';
import { inHeadUnit } from '@/utils/hydra/in-head-unit';

/** The rule's asset in the spendable in-head balance; zero when the head holds none. */
export function spendableAmountOf(balance: Pick<HydraHeadOwnBalance, 'spendableBalance'>, assetUnit: string): bigint {
	const key = inHeadUnit(assetUnit).toLowerCase();
	return BigInt(balance.spendableBalance.find((asset) => asset.unit.toLowerCase() === key)?.quantity ?? '0');
}
