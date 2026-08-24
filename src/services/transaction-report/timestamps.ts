import type { ReportOnChainState, RevenueMode } from './metrics';

export type ReportTransactionEvent = Readonly<{
	id: string;
	txHash: string | null;
	status: string | null;
	newOnChainState: ReportOnChainState | null;
	blockTime: number | null;
	fees: bigint | null;
	relatedRequestKeys?: readonly string[] | null;
	relatedPaymentKeys?: readonly string[] | null;
	relatedPaymentKeysComplete?: boolean;
}>;

export type ReportTransactionFeeWindow = Readonly<{
	dateBasis: 'CreatedAt' | 'FundsLockedAt' | 'RevenueRecognizedAt';
	from: Date;
	to: Date;
}>;

function mergeOptionalEvidence<T>(values: ReadonlyArray<T | null>): T | null {
	const presentValues = values.filter((value): value is T => value != null);
	if (presentValues.length === 0) return null;
	return presentValues.every((value) => value === presentValues[0]) ? presentValues[0] : null;
}

function mergeTransactionStatus(values: ReadonlyArray<string | null>): string | null {
	const statuses = Array.from(new Set(values.filter((value): value is string => value != null)));
	if (statuses.length <= 1) return statuses[0] ?? null;
	const terminalStatuses = statuses.filter((status) => status !== 'Pending');
	return terminalStatuses.length === 1 ? terminalStatuses[0] : null;
}

function mergeRelatedKeys(values: ReadonlyArray<readonly string[] | null | undefined>): readonly string[] | null {
	const presentValues = values.filter((value): value is readonly string[] => value != null);
	if (presentValues.length === 0) return null;
	return Array.from(new Set(presentValues.flat())).sort((left, right) => left.localeCompare(right));
}

export function mergeReportTransactions(transactions: readonly ReportTransactionEvent[]): ReportTransactionEvent[] {
	const groups = new Map<string, ReportTransactionEvent[]>();
	for (const transaction of transactions) {
		const key = transaction.txHash == null ? `id:${transaction.id}` : `hash:${transaction.txHash}`;
		const group = groups.get(key);
		if (group == null) groups.set(key, [transaction]);
		else group.push(transaction);
	}

	return Array.from(groups.entries())
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([_key, group]) => ({
			id: group.map((transaction) => transaction.id).sort()[0],
			txHash: mergeOptionalEvidence(group.map((transaction) => transaction.txHash)),
			status: mergeTransactionStatus(group.map((transaction) => transaction.status)),
			newOnChainState: mergeOptionalEvidence(group.map((transaction) => transaction.newOnChainState)),
			blockTime: mergeOptionalEvidence(group.map((transaction) => transaction.blockTime)),
			fees: mergeOptionalEvidence(group.map((transaction) => transaction.fees)),
			relatedRequestKeys: mergeRelatedKeys(group.map((transaction) => transaction.relatedRequestKeys)),
			relatedPaymentKeys: mergeRelatedKeys(group.map((transaction) => transaction.relatedPaymentKeys)),
			relatedPaymentKeysComplete: group.every((transaction) => transaction.relatedPaymentKeysComplete !== false),
		}));
}

function dateFromBlockTime(blockTime: number | null): Date | null {
	if (blockTime == null || !Number.isSafeInteger(blockTime) || blockTime < 0) return null;
	const date = new Date(blockTime * 1000);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function getReportFeeTransactions(
	transactions: readonly ReportTransactionEvent[],
	window?: ReportTransactionFeeWindow,
): ReportTransactionEvent[] {
	return mergeReportTransactions(transactions).filter((transaction) => {
		if (window?.dateBasis !== 'RevenueRecognizedAt') return true;
		const blockTime = dateFromBlockTime(transaction.blockTime);
		return (
			blockTime == null || (blockTime.getTime() >= window.from.getTime() && blockTime.getTime() < window.to.getTime())
		);
	});
}

function dateFromMilliseconds(milliseconds: bigint): Date | null {
	if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	const date = new Date(Number(milliseconds));
	return Number.isNaN(date.getTime()) ? null : date;
}

function getConfirmedStateTime(
	transactions: readonly ReportTransactionEvent[],
	state: ReportOnChainState,
): Date | null {
	const matchingTimes = mergeReportTransactions(transactions)
		.filter((transaction) => isConfirmedStateTransaction(transaction, state))
		.map((transaction) => dateFromBlockTime(transaction.blockTime))
		.filter((value): value is Date => value != null)
		.sort((left, right) => left.getTime() - right.getTime());
	return matchingTimes[0] ?? null;
}

function isConfirmedStateTransaction(transaction: ReportTransactionEvent, state: ReportOnChainState): boolean {
	return transaction.status === 'Confirmed' && transaction.txHash != null && transaction.newOnChainState === state;
}

export function hasConfirmedStateTransaction(
	transactions: readonly ReportTransactionEvent[],
	state: ReportOnChainState,
): boolean {
	return mergeReportTransactions(transactions).some((transaction) => isConfirmedStateTransaction(transaction, state));
}

export function hasConfirmedOnChainTransaction(transactions: readonly ReportTransactionEvent[]): boolean {
	return mergeReportTransactions(transactions).some(
		(transaction) => transaction.status === 'Confirmed' && transaction.txHash != null,
	);
}

export function sumPerRequestConfirmedTransactionFees(
	transactions: readonly ReportTransactionEvent[],
	allocationScope: 'single_request' | 'shared_or_unknown',
	window?: ReportTransactionFeeWindow,
	currentPaymentKey?: string,
): {
	amount: bigint | null;
	completeness: 'complete' | 'partial';
} {
	const mergedTransactions = getReportFeeTransactions(transactions, window);
	if (mergedTransactions.some((transaction) => transaction.status == null)) {
		return { amount: null, completeness: 'partial' };
	}
	const confirmedTransactions = mergedTransactions.filter((transaction) => transaction.status === 'Confirmed');
	if (
		confirmedTransactions.some(
			(transaction) =>
				transaction.txHash == null ||
				transaction.fees == null ||
				transaction.fees < 0n ||
				(window?.dateBasis === 'RevenueRecognizedAt' && dateFromBlockTime(transaction.blockTime) == null),
		)
	) {
		return { amount: null, completeness: 'partial' };
	}
	const hasAmbiguousNonzeroFee = confirmedTransactions.some((transaction) => {
		if (transaction.fees === 0n) return false;
		if (transaction.relatedPaymentKeysComplete === false) return true;
		if (currentPaymentKey == null) return allocationScope === 'shared_or_unknown';
		const paymentKeys = Array.from(new Set(transaction.relatedPaymentKeys ?? []));
		return paymentKeys.length !== 1 || paymentKeys[0] !== currentPaymentKey;
	});
	if (hasAmbiguousNonzeroFee) return { amount: null, completeness: 'partial' };
	return {
		amount: confirmedTransactions.reduce((total, transaction) => total + transaction.fees!, 0n),
		completeness: 'complete',
	};
}

export function getReportTimestamps(input: {
	createdAt: Date;
	onChainState: ReportOnChainState | null;
	unlockTime: bigint;
	asOfTime: bigint;
	revenueMode: RevenueMode;
	transactions: readonly ReportTransactionEvent[];
}) {
	const fundsLockedAt = getConfirmedStateTime(input.transactions, 'FundsLocked');
	const withdrawnAt =
		input.onChainState === 'Withdrawn' ? getConfirmedStateTime(input.transactions, 'Withdrawn') : null;
	let sellerRevenueRecognizedAt: Date | null = null;
	if (input.revenueMode === 'RequestedGross') {
		sellerRevenueRecognizedAt = input.createdAt;
	} else if (
		input.revenueMode === 'Billable' &&
		input.onChainState === 'ResultSubmitted' &&
		input.unlockTime <= input.asOfTime &&
		hasConfirmedStateTransaction(input.transactions, 'ResultSubmitted')
	) {
		sellerRevenueRecognizedAt = dateFromMilliseconds(input.unlockTime);
	} else if (input.onChainState === 'Withdrawn') {
		const unlockAt = dateFromMilliseconds(input.unlockTime);
		const wasBillableBeforeWithdrawal =
			input.revenueMode === 'Billable' &&
			unlockAt != null &&
			withdrawnAt != null &&
			unlockAt.getTime() <= withdrawnAt.getTime() &&
			hasConfirmedStateTransaction(input.transactions, 'ResultSubmitted');
		sellerRevenueRecognizedAt = wasBillableBeforeWithdrawal ? unlockAt : withdrawnAt;
	} else if (input.onChainState === 'DisputedWithdrawn') {
		sellerRevenueRecognizedAt = getConfirmedStateTime(input.transactions, input.onChainState);
	}

	const buyerReturnedAt =
		input.onChainState === 'RefundWithdrawn' || input.onChainState === 'DisputedWithdrawn'
			? getConfirmedStateTime(input.transactions, input.onChainState)
			: null;

	return {
		createdAt: input.createdAt,
		fundsLockedAt,
		sellerRevenueRecognizedAt,
		buyerGrossSpendAt: fundsLockedAt,
		buyerReturnedAt,
	};
}
