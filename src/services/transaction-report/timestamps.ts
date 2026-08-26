import { feeShareForPaymentKey } from './fee-split';
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

function getConfirmedStateTimes(
	transactions: readonly ReportTransactionEvent[],
	state: ReportOnChainState,
): Date[] {
	return mergeReportTransactions(transactions)
		.filter((transaction) => isConfirmedStateTransaction(transaction, state))
		.map((transaction) => dateFromBlockTime(transaction.blockTime))
		.filter((value): value is Date => value != null)
		.sort((left, right) => left.getTime() - right.getTime());
}

function getConfirmedStateTime(
	transactions: readonly ReportTransactionEvent[],
	state: ReportOnChainState,
): Date | null {
	return getConfirmedStateTimes(transactions, state)[0] ?? null;
}

/**
 * States in which the seller cannot withdraw, because the buyer is contesting
 * the payment or a refund is already on its way.
 */
const REPORT_REFUND_SIDE_STATES: ReadonlySet<ReportOnChainState> = new Set([
	'RefundRequested',
	'Disputed',
	'RefundAuthorized',
]);

/** States in which the seller may withdraw once the unlock time has passed. */
const REPORT_SELLER_CLEARED_STATES: ReadonlySet<ReportOnChainState> = new Set([
	'ResultSubmitted',
	'WithdrawAuthorized',
]);

/**
 * The moment a contested request became uncontested again, if it ever was
 * contested.
 *
 * The buyer can request a refund and later cancel it, and `UnSetRefundRequested`
 * puts the request back where it was. Re-submitting a result does not count,
 * because the request was never contested in that case.
 */
function getRefundClearedTime(transactions: readonly ReportTransactionEvent[]): Date | null {
	const transitions = mergeReportTransactions(transactions)
		.filter((transaction) => transaction.status === 'Confirmed' && transaction.txHash != null)
		.map((transaction) => ({ state: transaction.newOnChainState, at: dateFromBlockTime(transaction.blockTime) }))
		.filter((transition): transition is { state: ReportOnChainState; at: Date } =>
			Boolean(transition.state != null && transition.at != null),
		)
		.sort((left, right) => left.at.getTime() - right.at.getTime());

	let clearedAt: Date | null = null;
	let isContested = false;
	for (const transition of transitions) {
		if (REPORT_REFUND_SIDE_STATES.has(transition.state)) {
			isContested = true;
			clearedAt = null;
		} else if (isContested && REPORT_SELLER_CLEARED_STATES.has(transition.state) && clearedAt == null) {
			clearedAt = transition.at;
		}
	}
	return clearedAt;
}

function isConfirmedStateTransaction(transaction: ReportTransactionEvent, state: ReportOnChainState): boolean {
	return transaction.status === 'Confirmed' && transaction.txHash != null && transaction.newOnChainState === state;
}

/**
 * The on-chain states that end an escrow. Each is reached by its own withdraw
 * transaction, and a request reaches at most one of them.
 */
const REPORT_SETTLEMENT_STATES = ['Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn'] as const;

export type ReportSettlementEvidence = Readonly<{
	/** Hash of the confirmed transaction that submitted the result, if any. */
	resultSubmittedTxHash: string | null;
	/** Hash of the confirmed withdraw transaction, if the escrow already ended. */
	settlementTxHash: string | null;
	/** Which withdraw it was, as the on-chain state that transaction produced. */
	settlementTxType: (typeof REPORT_SETTLEMENT_STATES)[number] | null;
}>;

function getConfirmedStateTransaction(
	transactions: readonly ReportTransactionEvent[],
	state: ReportOnChainState,
): ReportTransactionEvent | null {
	return (
		mergeReportTransactions(transactions)
			.filter((transaction) => isConfirmedStateTransaction(transaction, state))
			// A confirmed transaction can still miss its block time, so ordering
			// falls back to the hash rather than dropping the row.
			.sort(
				(left, right) =>
					(left.blockTime ?? Number.MAX_SAFE_INTEGER) - (right.blockTime ?? Number.MAX_SAFE_INTEGER) ||
					(left.txHash ?? '').localeCompare(right.txHash ?? ''),
			)[0] ?? null
	);
}

/**
 * The transaction hashes an operator needs to tie a report row back to the
 * chain: the withdraw that ended the escrow, and the result submission that
 * came before it. Both are reported, because a row that is not withdrawn yet
 * still has a submitted result to point at.
 */
export function getReportSettlementEvidence(transactions: readonly ReportTransactionEvent[]): ReportSettlementEvidence {
	const settlements = REPORT_SETTLEMENT_STATES.map((state) => ({
		state,
		transaction: getConfirmedStateTransaction(transactions, state),
	})).filter((candidate) => candidate.transaction != null);
	const settlement = settlements.sort(
		(left, right) =>
			(left.transaction!.blockTime ?? Number.MAX_SAFE_INTEGER) -
			(right.transaction!.blockTime ?? Number.MAX_SAFE_INTEGER),
	)[0];

	return {
		resultSubmittedTxHash: getConfirmedStateTransaction(transactions, 'ResultSubmitted')?.txHash ?? null,
		settlementTxHash: settlement?.transaction?.txHash ?? null,
		settlementTxType: settlement?.state ?? null,
	};
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
	// One transaction can settle several requests. Such a fee is divided into
	// equal parts, one per request, and the parts add back up to the fee
	// exactly. A part is this request's fee, so it is reported the same way a
	// fee of its own would be. See ./fee-split.
	let total = 0n;
	for (const transaction of confirmedTransactions) {
		const fee = transaction.fees!;
		if (fee === 0n) continue;
		// Without the full list of requests the transaction settled there is no
		// denominator, so no share can be worked out at all.
		if (transaction.relatedPaymentKeysComplete === false) return { amount: null, completeness: 'partial' };
		if (currentPaymentKey == null) {
			if (allocationScope === 'shared_or_unknown') return { amount: null, completeness: 'partial' };
			total += fee;
			continue;
		}
		const paymentKeys = transaction.relatedPaymentKeys ?? [];
		const share = feeShareForPaymentKey(fee, paymentKeys, currentPaymentKey);
		if (share == null) return { amount: null, completeness: 'partial' };
		total += share;
	}
	return { amount: total, completeness: 'complete' };
}

/** The datum's result hash, once the seller has submitted one. */
function hasSubmittedResult(resultHash: string | null): boolean {
	return resultHash != null && resultHash.length > 0;
}

/**
 * The date a seller's work becomes billable.
 *
 * That is the unlock time in the ordinary case, because the seller submits the
 * result before the unlock and the buyer's window to dispute runs out then.
 *
 * A refund request that the buyer cancels breaks that order. The cancellation
 * can land after the unlock time, and the request only becomes billable at the
 * cancellation, so the later of the two dates is the billable one. Booking the
 * unlock date instead would put revenue into a period that was already
 * reported.
 *
 * Only a contested request moves its date this way. `SubmitResult` is valid
 * from every state, so a seller can re-submit a result at any time, and that
 * re-submission changes nothing about when the payment became billable.
 */
function getBillableAt(transactions: readonly ReportTransactionEvent[], unlockTime: bigint): Date | null {
	const unlockAt = dateFromMilliseconds(unlockTime);
	const clearedAt = getRefundClearedTime(transactions);
	if (unlockAt == null) return null;
	if (clearedAt == null) return unlockAt;
	return clearedAt.getTime() > unlockAt.getTime() ? clearedAt : unlockAt;
}

export function getReportTimestamps(input: {
	createdAt: Date;
	onChainState: ReportOnChainState | null;
	resultHash: string | null;
	unlockTime: bigint;
	asOfTime: bigint;
	revenueMode: RevenueMode;
	transactions: readonly ReportTransactionEvent[];
}) {
	const fundsLockedAt = getConfirmedStateTime(input.transactions, 'FundsLocked');
	const withdrawnAt =
		input.onChainState === 'Withdrawn' ? getConfirmedStateTime(input.transactions, 'Withdrawn') : null;
	const billableAt = getBillableAt(input.transactions, input.unlockTime);
	let sellerRevenueRecognizedAt: Date | null = null;
	if (input.revenueMode === 'RequestedGross') {
		sellerRevenueRecognizedAt = input.createdAt;
	} else if (
		input.revenueMode === 'Billable' &&
		input.onChainState === 'ResultSubmitted' &&
		input.unlockTime <= input.asOfTime &&
		hasConfirmedStateTransaction(input.transactions, 'ResultSubmitted')
	) {
		sellerRevenueRecognizedAt = billableAt;
	} else if (input.onChainState === 'Withdrawn') {
		// A seller withdrawal is only valid from `ResultSubmitted` and only after
		// the unlock time, so a `Withdrawn` request with a result hash was
		// already billable before the withdrawal and keeps that earlier date.
		//
		// The proof is the stored result hash rather than a surviving
		// `ResultSubmitted` transaction row. A row can go missing, or sit in a
		// non-confirmed status after a rollback, and the date would then move to
		// the withdrawal. That rebooks revenue a closed period already reported.
		const wasBillableBeforeWithdrawal =
			input.revenueMode === 'Billable' &&
			billableAt != null &&
			withdrawnAt != null &&
			billableAt.getTime() <= withdrawnAt.getTime() &&
			hasSubmittedResult(input.resultHash);
		sellerRevenueRecognizedAt = wasBillableBeforeWithdrawal ? billableAt : withdrawnAt;
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
