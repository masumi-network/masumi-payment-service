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

function hasKnownDateMembership(row: ReportRow, dateBasis: ReportDateBasis, from: Date, to: Date): boolean {
	if (dateBasis === 'CreatedAt') return isDateInRange(row.createdAt, from, to);
	if (dateBasis === 'FundsLockedAt') return isDateInRange(row.timestamps.fundsLockedAt, from, to);
	if (
		[row.timestamps.sellerRevenueRecognizedAt, row.timestamps.buyerGrossSpendAt, row.timestamps.buyerReturnedAt].some(
			(value) => isDateInRange(value, from, to),
		)
	) {
		return true;
	}
	return getKnownReportTransactionDates(row).some((date) => isDateInRange(date, from, to));
}

export function getReportTransactionCount(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
) {
	const membershipByPayment = new Map<string, boolean>();
	for (const row of rows) {
		membershipByPayment.set(
			row.blockchainIdentifier,
			(membershipByPayment.get(row.blockchainIdentifier) ?? false) || hasKnownDateMembership(row, dateBasis, from, to),
		);
	}
	const memberships = Array.from(membershipByPayment.values());
	return {
		transactionCount: memberships.filter(Boolean).length,
		transactionCountCompleteness: memberships.every(Boolean) ? ('complete' as const) : ('partial' as const),
	};
}
