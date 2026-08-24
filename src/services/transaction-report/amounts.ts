import { normalizeAssetUnit } from '@/utils/asset-units';

export type AtomicAmount = Readonly<{
	unit: string;
	amount: bigint;
}>;
export type AmountAccumulator = Map<string, bigint>;

function sortAmounts(left: AtomicAmount, right: AtomicAmount): number {
	if (left.unit === 'lovelace') return right.unit === 'lovelace' ? 0 : -1;
	if (right.unit === 'lovelace') return 1;
	return left.unit.localeCompare(right.unit);
}

export function createAmountAccumulator(): AmountAccumulator {
	return new Map<string, bigint>();
}

export function accumulateAmounts(totals: AmountAccumulator, values: readonly AtomicAmount[]): void {
	for (const value of values) {
		const unit = normalizeAssetUnit(value.unit);
		totals.set(unit, (totals.get(unit) ?? 0n) + value.amount);
	}
}

export function materializeAmounts(totals: ReadonlyMap<string, bigint>): AtomicAmount[] {
	return Array.from(totals, ([unit, amount]) => ({ unit, amount }))
		.filter((value) => value.amount !== 0n)
		.sort(sortAmounts);
}

export function normalizeAmounts(values: readonly AtomicAmount[]): AtomicAmount[] {
	const totals = createAmountAccumulator();
	accumulateAmounts(totals, values);
	return materializeAmounts(totals);
}

export function addAmounts(...groups: ReadonlyArray<readonly AtomicAmount[]>): AtomicAmount[] {
	return normalizeAmounts(groups.flatMap((group) => group));
}

export function subtractAmounts(
	minuend: readonly AtomicAmount[],
	...subtrahends: ReadonlyArray<readonly AtomicAmount[]>
): AtomicAmount[] {
	return addAmounts(
		minuend,
		...subtrahends.map((group) => group.map((value) => ({ unit: value.unit, amount: -value.amount }))),
	);
}

export function getAtomicAmount(values: readonly AtomicAmount[], unit: string): bigint {
	const normalizedUnit = normalizeAssetUnit(unit);
	return normalizeAmounts(values).find((value) => value.unit === normalizedUnit)?.amount ?? 0n;
}

export function cardanoFeeAmount(amount: bigint): AtomicAmount[] {
	return amount === 0n ? [] : [{ unit: 'lovelace', amount }];
}
