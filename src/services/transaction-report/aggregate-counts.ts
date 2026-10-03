import type { ReportMetricWindow, ReportRow } from './records';

type ReportDateBasis = ReportMetricWindow['dateBasis'];

function isDateInRange(value: Date | null, from: Date, to: Date): boolean {
	return value != null && value.getTime() >= from.getTime() && value.getTime() < to.getTime();
}

export function getKnownReportTransactionDates(row: ReportRow): Date[] {
	return row.transactions.flatMap((transaction) => {
		if (
			transaction.status !== 'Confirmed' ||
			transaction.txHash == null ||
			transaction.blockTime == null ||
			!Number.isSafeInteger(transaction.blockTime) ||
			transaction.blockTime < 0
		) {
			return [];
		}
		const date = new Date(transaction.blockTime * 1000);
		return Number.isNaN(date.getTime()) ? [] : [date];
	});
}

/** Every date that can put a request inside the report, under this date basis. */
function countableDates(row: ReportRow, dateBasis: ReportDateBasis): Array<Date | null> {
	if (dateBasis === 'CreatedAt') return [row.createdAt];
	if (dateBasis === 'FundsLockedAt') return [row.timestamps.fundsLockedAt];
	return [
		row.timestamps.sellerRevenueRecognizedAt,
		row.timestamps.buyerGrossSpendAt,
		row.timestamps.buyerReturnedAt,
		...getKnownReportTransactionDates(row),
	];
}

/**
 * The one date each request is counted on, keyed by its chain identifier.
 *
 * A request can touch several days: locked on one, settled on another. Counting
 * it on each of them would make the daily counts add up to more than the period
 * total, so the earliest day inside the report wins and the rest are ignored.
 * A `null` marks a request the report holds but cannot date, which is what makes
 * the count partial.
 */
export function getReportCountDates(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
): Map<string, Date | null> {
	const dateByPayment = new Map<string, Date | null>();
	for (const row of rows) {
		let earliest = dateByPayment.get(row.blockchainIdentifier) ?? null;
		for (const candidate of countableDates(row, dateBasis)) {
			if (!isDateInRange(candidate, from, to)) continue;
			if (earliest == null || (candidate as Date).getTime() < earliest.getTime()) earliest = candidate as Date;
		}
		dateByPayment.set(row.blockchainIdentifier, earliest);
	}
	return dateByPayment;
}

export function getReportTransactionCount(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
) {
	const dates = Array.from(getReportCountDates(rows, dateBasis, from, to).values());
	return {
		transactionCount: dates.filter((date) => date != null).length,
		transactionCountCompleteness: dates.every((date) => date != null) ? ('complete' as const) : ('partial' as const),
	};
}
