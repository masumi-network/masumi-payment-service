import createHttpError from 'http-errors';

export const REPORT_MAX_TRANSACTION_HISTORY_PER_REQUEST = 100;
export const REPORT_MAX_FUND_ROWS_PER_REQUEST = 1_000;

export function assertBoundedRequestRelations(
	transactionHistory: { length: number },
	...fundRelations: Array<{ length: number }>
): void {
	if (transactionHistory.length > REPORT_MAX_TRANSACTION_HISTORY_PER_REQUEST) {
		throw createHttpError(
			413,
			`Report request exceeds ${REPORT_MAX_TRANSACTION_HISTORY_PER_REQUEST} transaction history rows. Narrow the report filters.`,
		);
	}
	if (fundRelations.some((relation) => relation.length > REPORT_MAX_FUND_ROWS_PER_REQUEST)) {
		throw createHttpError(
			413,
			`Report request exceeds ${REPORT_MAX_FUND_ROWS_PER_REQUEST} fund rows. Narrow the report filters.`,
		);
	}
}
