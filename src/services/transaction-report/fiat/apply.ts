import { fiatAssetUnit, normalizeAssetUnit } from '@/utils/asset-units';
import type { AtomicAmount } from '../amounts';
import type { ReportMetricWindow, ReportRow } from '../records';
import { withFiatAmount } from './convert';
import type { FiatRateContext, FiatRateSource, FiatRateTable, FiatRowRates } from './rates';

type ReportDateBasis = ReportMetricWindow['dateBasis'];

export type FiatWindow = Readonly<{ from: Date; to: Date }>;

/**
 * The one date a request is converted on.
 *
 * A request keeps a single rate across all of its figures, so gross minus fees
 * still equals net after conversion. Converting each figure on its own date
 * would break that identity for anyone who checks the arithmetic.
 */
function accountingDate(row: ReportRow, dateBasis: ReportDateBasis): Date {
	if (dateBasis === 'FundsLockedAt') return row.timestamps.fundsLockedAt ?? row.createdAt;
	if (dateBasis === 'CreatedAt') return row.createdAt;
	const recognized =
		row.role === 'Seller' ? row.timestamps.sellerRevenueRecognizedAt : row.timestamps.buyerGrossSpendAt;
	return recognized ?? row.timestamps.fundsLockedAt ?? row.createdAt;
}

function rateContext(
	row: ReportRow,
	table: FiatRateTable,
	dateBasis: ReportDateBasis,
	window: FiatWindow,
): FiatRateContext {
	return table.mode === 'AccountingDate' ? { at: accountingDate(row, dateBasis) } : window;
}

/** Every on-chain asset the row actually holds, so no rate is reported unused. */
function rowAssetUnits(row: ReportRow): string[] {
	const units = new Set<string>();
	for (const group of [row.requestedFunds, row.withdrawnForBuyer, row.withdrawnForSeller]) {
		for (const amount of group) {
			if (amount.amount !== 0n) units.add(normalizeAssetUnit(amount.unit));
		}
	}
	// Cardano fees are always lovelace, and every row can carry them.
	units.add('lovelace');
	return [...units];
}

function fiatValueOf(amounts: readonly AtomicAmount[] | null, unit: string): bigint | null {
	if (amounts == null) return null;
	const entry = amounts.find((amount) => amount.unit === unit);
	return entry?.amount ?? null;
}

/**
 * Rewrites a derived figure's fiat value from the figures it is derived from.
 *
 * Converting a net figure on its own can round one millionth away from its own
 * parts, and a reader who checks gross minus fees against net would find that
 * gap and go looking for a bug that is not there.
 */
function withDerivedFiat(
	amounts: AtomicAmount[] | null,
	unit: string,
	parts: ReadonlyArray<readonly [sign: 1n | -1n, value: bigint | null]>,
): AtomicAmount[] | null {
	if (amounts == null || fiatValueOf(amounts, unit) == null) return amounts;
	let derived = 0n;
	for (const [sign, value] of parts) {
		if (value == null) return amounts;
		derived += sign * value;
	}
	return amounts.map((amount) => (amount.unit === unit ? { ...amount, amount: derived } : amount));
}

export type FiatApplyResult = Readonly<{
	rows: ReportRow[];
	/** Units no rate could be found for. Their figures carry no fiat column. */
	missingUnits: readonly string[];
}>;

/**
 * Appends a fiat figure to every money column of every row.
 *
 * A row whose assets are not all priced keeps its crypto figures and gains no
 * fiat figure, so a fiat total can never quietly leave money out.
 */
export function applyFiatToReportRows(
	rows: readonly ReportRow[],
	table: FiatRateTable,
	dateBasis: ReportDateBasis,
	window: FiatWindow,
): FiatApplyResult {
	const missingUnits = new Set<string>();
	const converted = rows.map((row) => {
		const context = rateContext(row, table, dateBasis, window);
		const usedRates = new Map<string, Readonly<{ unit: string; rate: string; source: FiatRateSource }>>();
		for (const unit of rowAssetUnits(row)) {
			const lookup = table.rateFor(unit, context);
			if (lookup != null) usedRates.set(unit, { unit, rate: lookup.rate, source: lookup.source });
		}
		const convert = (amounts: readonly AtomicAmount[] | null): AtomicAmount[] | null => {
			const result = withFiatAmount(amounts, table, context);
			for (const unit of result.missingUnits) missingUnits.add(unit);
			return result.amounts == null ? null : [...result.amounts];
		};
		const unit = fiatAssetUnit(table.currency);
		let seller = null as ReportRow['seller'];
		if (row.seller != null) {
			const grossRevenue = convert(row.seller.grossRevenue);
			const protocolFee = convert(row.seller.protocolFee.amounts);
			const cardanoFees = convert(row.seller.cardanoFees) ?? row.seller.cardanoFees;
			seller = {
				...row.seller,
				grossRevenue,
				protocolFee: { ...row.seller.protocolFee, amounts: protocolFee },
				cardanoFees,
				netRevenue: withDerivedFiat(convert(row.seller.netRevenue), unit, [
					[1n, fiatValueOf(grossRevenue, unit)],
					[-1n, fiatValueOf(protocolFee, unit)],
					[-1n, fiatValueOf(cardanoFees, unit)],
				]),
			};
		}
		let buyer = null as ReportRow['buyer'];
		if (row.buyer != null) {
			const grossSpend = convert(row.buyer.grossSpend);
			const returnedFunds = convert(row.buyer.returnedFunds);
			const cardanoFees = convert(row.buyer.cardanoFees) ?? row.buyer.cardanoFees;
			buyer = {
				...row.buyer,
				grossSpend,
				returnedFunds,
				cardanoFees,
				netSpend: withDerivedFiat(convert(row.buyer.netSpend), unit, [
					[1n, fiatValueOf(grossSpend, unit)],
					[-1n, fiatValueOf(returnedFunds, unit)],
					[1n, fiatValueOf(cardanoFees, unit)],
				]),
			};
		}
		return { ...row, seller, buyer, fiatRates: [...usedRates.values()] satisfies FiatRowRates };
	});
	return { rows: converted, missingUnits: [...missingUnits] };
}
