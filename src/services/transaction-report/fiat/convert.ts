import { fiatAssetUnit, getReportAssetMetadata, isFiatAssetUnit } from '@/utils/asset-units';
import type { AtomicAmount } from '../amounts';
import { parseRateToScaled, type FiatRateContext, type FiatRateSource, type FiatRateTable } from './rates';

/** Fiat is carried in millionths, the same scale as every supported asset. */
export const FIAT_DECIMALS = 6;

const RATE_DECIMALS = 12;

/** Multiplies an atomic asset amount by a rate, rounding half away from zero. */
export function convertAtomicToFiat(amount: bigint, assetDecimals: number, rate: string): bigint {
	const scaledRate = parseRateToScaled(rate, RATE_DECIMALS);
	const divisor = 10n ** BigInt(RATE_DECIMALS + assetDecimals - FIAT_DECIMALS);
	const product = amount * scaledRate;
	const isNegative = product < 0n;
	const absolute = isNegative ? -product : product;
	const rounded = (absolute + divisor / 2n) / divisor;
	return isNegative ? -rounded : rounded;
}

export type FiatConversion = Readonly<{
	amount: bigint;
	sources: readonly FiatRateSource[];
	/** Units the table had no rate for. A conversion with any of these is not usable. */
	missingUnits: readonly string[];
}>;

/**
 * Converts one metric's per-asset amounts into a single fiat amount.
 *
 * A missing rate for any asset in the metric makes the whole conversion
 * unusable: a partial sum would understate the figure while looking exact.
 */
export function convertAmountsToFiat(
	amounts: readonly AtomicAmount[],
	table: FiatRateTable,
	context: FiatRateContext,
): FiatConversion {
	let total = 0n;
	const sources = new Set<FiatRateSource>();
	const missingUnits: string[] = [];

	for (const amount of amounts) {
		if (isFiatAssetUnit(amount.unit)) continue;
		if (amount.amount === 0n) continue;
		const metadata = getReportAssetMetadata(amount.unit);
		const lookup = table.rateFor(amount.unit, context);
		if (metadata == null || lookup == null) {
			missingUnits.push(amount.unit);
			continue;
		}
		sources.add(lookup.source);
		total += convertAtomicToFiat(amount.amount, metadata.decimals, lookup.rate);
	}

	return { amount: total, sources: [...sources], missingUnits };
}

/**
 * Appends the fiat total to a metric's amounts, or leaves them untouched when
 * any asset in the metric has no rate.
 */
export function withFiatAmount(
	amounts: readonly AtomicAmount[] | null,
	table: FiatRateTable,
	context: FiatRateContext,
): Readonly<{ amounts: readonly AtomicAmount[] | null; missingUnits: readonly string[] }> {
	if (amounts == null) return { amounts, missingUnits: [] };
	const conversion = convertAmountsToFiat(amounts, table, context);
	if (conversion.missingUnits.length > 0) return { amounts, missingUnits: conversion.missingUnits };
	return {
		amounts: [...amounts, { unit: fiatAssetUnit(table.currency), amount: conversion.amount }],
		missingUnits: [],
	};
}
