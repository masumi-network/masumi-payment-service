import { Prisma, TransactionStatus } from '@/generated/prisma/client';
import createHttpError from 'http-errors';
import type { ReportRequestRecord } from './records';
import { mergeReportTransactions, type ReportTransactionEvent } from './timestamps';

export type ReportTransactionReader = Pick<Prisma.TransactionClient, 'transaction'>;

const REPORT_MAX_RELATED_REQUESTS_PER_TRANSACTION = 100;
const REPORT_MAX_TRANSACTION_HASHES_PER_ENRICHMENT = 5_000;
const REPORT_MAX_ENRICHED_TRANSACTIONS = 5_000;
const REPORT_TRANSACTION_HYDRATION_BATCH_SIZE = 50;
const REPORT_MAX_RELATED_REQUEST_ROWS_PER_ENRICHMENT = 100_000;

const relatedRequestSelect = { id: true, blockchainIdentifier: true } as const;
const reportTransactionScalarSelect = {
	id: true,
	txHash: true,
	status: true,
	newOnChainState: true,
	blockTime: true,
	fees: true,
} as const;

export const attachedReportTransactionSelect = reportTransactionScalarSelect satisfies Prisma.TransactionSelect;

export const reportTransactionSelect = {
	...reportTransactionScalarSelect,
	PaymentRequestCurrent: { take: REPORT_MAX_RELATED_REQUESTS_PER_TRANSACTION + 1, select: relatedRequestSelect },
	PurchaseRequestCurrent: { take: REPORT_MAX_RELATED_REQUESTS_PER_TRANSACTION + 1, select: relatedRequestSelect },
	PaymentRequestHistory: { take: REPORT_MAX_RELATED_REQUESTS_PER_TRANSACTION + 1, select: relatedRequestSelect },
	PurchaseRequestHistory: { take: REPORT_MAX_RELATED_REQUESTS_PER_TRANSACTION + 1, select: relatedRequestSelect },
} satisfies Prisma.TransactionSelect;

type SelectedReportTransaction = Prisma.TransactionGetPayload<{ select: typeof reportTransactionSelect }>;
type SelectedAttachedReportTransaction = Prisma.TransactionGetPayload<{
	select: typeof attachedReportTransactionSelect;
}>;
type TransactionEvidenceAccumulator = {
	id: string;
	txHashes: Set<string>;
	statuses: Set<string>;
	states: Set<NonNullable<ReportTransactionEvent['newOnChainState']>>;
	blockTimes: Set<number>;
	fees: Set<bigint>;
	relatedRequestKeys: Set<string>;
	relatedPaymentKeys: Set<string>;
};

function sortedUnique(values: readonly string[]): string[] {
	return Array.from(new Set(values)).sort();
}

function assertReportQueryActive(signal?: AbortSignal): void {
	if (signal?.aborted) throw createHttpError(504, 'Report calculation timed out. Narrow the report filters.');
}

export function mapAttachedReportTransaction(
	transaction: SelectedAttachedReportTransaction | null,
): ReportTransactionEvent | null {
	return transaction == null
		? null
		: {
				...transaction,
				relatedRequestKeys: null,
				relatedPaymentKeys: null,
				relatedPaymentKeysComplete: false,
			};
}

function relatedRequestKeys(transaction: SelectedReportTransaction): string[] {
	return sortedUnique([
		...transaction.PaymentRequestCurrent.map((request) => `Seller:${request.id}`),
		...transaction.PaymentRequestHistory.map((request) => `Seller:${request.id}`),
		...transaction.PurchaseRequestCurrent.map((request) => `Buyer:${request.id}`),
		...transaction.PurchaseRequestHistory.map((request) => `Buyer:${request.id}`),
	]);
}

function relatedPaymentKeys(transaction: SelectedReportTransaction): string[] {
	return sortedUnique([
		...transaction.PaymentRequestCurrent.map((request) => request.blockchainIdentifier),
		...transaction.PaymentRequestHistory.map((request) => request.blockchainIdentifier),
		...transaction.PurchaseRequestCurrent.map((request) => request.blockchainIdentifier),
		...transaction.PurchaseRequestHistory.map((request) => request.blockchainIdentifier),
	]);
}

export function mapReportTransaction(transaction: SelectedReportTransaction | null): ReportTransactionEvent | null {
	if (
		transaction != null &&
		[
			transaction.PaymentRequestCurrent,
			transaction.PaymentRequestHistory,
			transaction.PurchaseRequestCurrent,
			transaction.PurchaseRequestHistory,
		].some((requests) => requests.length > REPORT_MAX_RELATED_REQUESTS_PER_TRANSACTION)
	) {
		throw createHttpError(
			413,
			`Report transaction exceeds ${REPORT_MAX_RELATED_REQUESTS_PER_TRANSACTION} related requests. Narrow the report filters.`,
		);
	}
	return transaction == null
		? null
		: {
				id: transaction.id,
				txHash: transaction.txHash,
				status: transaction.status,
				newOnChainState: transaction.newOnChainState,
				blockTime: transaction.blockTime,
				fees: transaction.fees,
				relatedRequestKeys: relatedRequestKeys(transaction),
				relatedPaymentKeys: relatedPaymentKeys(transaction),
			};
}

export function reportFeeAllocationScope(
	transactions: readonly ReportTransactionEvent[],
): ReportRequestRecord['feeAllocationScope'] {
	const merged = mergeReportTransactions(transactions);
	if (merged.length === 0) return 'shared_or_unknown';
	return merged.some(
		(transaction) =>
			transaction.relatedPaymentKeysComplete === false || new Set(transaction.relatedPaymentKeys ?? []).size !== 1,
	)
		? 'shared_or_unknown'
		: 'single_request';
}

export function reportFeeComponentScope(
	transactions: readonly ReportTransactionEvent[],
	currentPaymentKey: string,
): ReportRequestRecord['feeComponentScope'] {
	let hasConfirmedTransaction = false;
	for (const transaction of mergeReportTransactions(transactions)) {
		if (transaction.status !== TransactionStatus.Confirmed) continue;
		hasConfirmedTransaction = true;
		if (transaction.fees === 0n) continue;
		if (transaction.relatedPaymentKeysComplete === false) return 'partial';
		const paymentKeys = sortedUnique(transaction.relatedPaymentKeys ?? []);
		if (paymentKeys.length !== 1 || paymentKeys[0] !== currentPaymentKey) return 'partial';
	}
	return hasConfirmedTransaction ? 'complete' : 'partial';
}

function addPresent<T>(values: Set<T>, value: T | null): void {
	if (value != null) values.add(value);
}

function accumulateTransactionEvidence(
	accumulators: Map<string, TransactionEvidenceAccumulator>,
	event: ReportTransactionEvent,
): void {
	if (event.txHash == null) return;
	let accumulator = accumulators.get(event.txHash);
	if (accumulator == null) {
		accumulator = {
			id: event.id,
			txHashes: new Set(),
			statuses: new Set(),
			states: new Set(),
			blockTimes: new Set(),
			fees: new Set(),
			relatedRequestKeys: new Set(),
			relatedPaymentKeys: new Set(),
		};
		accumulators.set(event.txHash, accumulator);
	}
	if (event.id.localeCompare(accumulator.id) < 0) accumulator.id = event.id;
	addPresent(accumulator.txHashes, event.txHash);
	addPresent(accumulator.statuses, event.status);
	addPresent(accumulator.states, event.newOnChainState);
	addPresent(accumulator.blockTimes, event.blockTime);
	addPresent(accumulator.fees, event.fees);
	for (const key of event.relatedRequestKeys ?? []) accumulator.relatedRequestKeys.add(key);
	for (const key of event.relatedPaymentKeys ?? []) accumulator.relatedPaymentKeys.add(key);
}

function oneOrNull<T>(values: Set<T>): T | null {
	const first = values.values().next();
	return values.size === 1 && !first.done ? first.value : null;
}

function mergedStatus(statuses: Set<string>): string | null {
	if (statuses.size <= 1) return statuses.values().next().value ?? null;
	const terminalStatuses = Array.from(statuses).filter((status) => status !== 'Pending');
	return terminalStatuses.length === 1 ? terminalStatuses[0] : null;
}

function materializeTransactionEvidence(
	txHash: string,
	accumulator: TransactionEvidenceAccumulator,
): ReportTransactionEvent {
	const fees = oneOrNull(accumulator.fees);
	return {
		id: accumulator.id,
		txHash: oneOrNull(accumulator.txHashes) ?? txHash,
		status: mergedStatus(accumulator.statuses),
		newOnChainState: oneOrNull(accumulator.states),
		blockTime: oneOrNull(accumulator.blockTimes),
		fees,
		relatedRequestKeys: Array.from(accumulator.relatedRequestKeys).sort((left, right) => left.localeCompare(right)),
		relatedPaymentKeys: Array.from(accumulator.relatedPaymentKeys).sort((left, right) => left.localeCompare(right)),
		relatedPaymentKeysComplete: fees === 0n,
	};
}

export async function enrichReportTransactionEvidence(
	records: readonly ReportRequestRecord[],
	database: ReportTransactionReader,
	signal?: AbortSignal,
): Promise<ReportRequestRecord[]> {
	assertReportQueryActive(signal);
	const txHashSet = new Set<string>();
	for (const record of records) {
		assertReportQueryActive(signal);
		for (const transaction of record.transactions) {
			assertReportQueryActive(signal);
			if (transaction.txHash != null) txHashSet.add(transaction.txHash);
			if (txHashSet.size > REPORT_MAX_TRANSACTION_HASHES_PER_ENRICHMENT) {
				throw createHttpError(
					413,
					`Report evidence exceeds ${REPORT_MAX_TRANSACTION_HASHES_PER_ENRICHMENT} transaction hashes. Narrow the report filters.`,
				);
			}
		}
	}
	const txHashes = Array.from(txHashSet).sort();
	if (txHashes.length === 0) return [...records];

	const scalarTransactions = await database.transaction.findMany({
		where: { txHash: { in: txHashes } },
		take: REPORT_MAX_ENRICHED_TRANSACTIONS + 1,
		select: attachedReportTransactionSelect,
	});
	assertReportQueryActive(signal);
	if (scalarTransactions.length > REPORT_MAX_ENRICHED_TRANSACTIONS) {
		throw createHttpError(
			413,
			`Report evidence exceeds ${REPORT_MAX_ENRICHED_TRANSACTIONS} transactions. Narrow the report filters.`,
		);
	}
	const evidence = new Map<string, TransactionEvidenceAccumulator>();
	const requestStateAmbiguousHashes = new Set<string>();
	const hydratedTransactionIds = new Set<string>();
	let relatedRequestRows = 0;
	for (let offset = 0; offset < scalarTransactions.length; offset += REPORT_TRANSACTION_HYDRATION_BATCH_SIZE) {
		assertReportQueryActive(signal);
		const transactionIds = scalarTransactions
			.slice(offset, offset + REPORT_TRANSACTION_HYDRATION_BATCH_SIZE)
			.map((transaction) => transaction.id);
		const transactionIdSet = new Set(transactionIds);
		const transactions = await database.transaction.findMany({
			where: { id: { in: transactionIds } },
			take: REPORT_TRANSACTION_HYDRATION_BATCH_SIZE + 1,
			select: reportTransactionSelect,
		});
		assertReportQueryActive(signal);
		if (transactions.length > REPORT_TRANSACTION_HYDRATION_BATCH_SIZE) {
			throw createHttpError(
				413,
				`Report evidence hydration exceeds ${REPORT_TRANSACTION_HYDRATION_BATCH_SIZE} transactions per batch. Narrow the report filters.`,
			);
		}
		for (const transaction of transactions) {
			assertReportQueryActive(signal);
			if (!transactionIdSet.has(transaction.id)) {
				throw createHttpError(500, 'Report transaction evidence query returned an invalid result.');
			}
			hydratedTransactionIds.add(transaction.id);
			relatedRequestRows +=
				transaction.PaymentRequestCurrent.length +
				transaction.PaymentRequestHistory.length +
				transaction.PurchaseRequestCurrent.length +
				transaction.PurchaseRequestHistory.length;
			if (relatedRequestRows > REPORT_MAX_RELATED_REQUEST_ROWS_PER_ENRICHMENT) {
				throw createHttpError(
					413,
					`Report evidence exceeds ${REPORT_MAX_RELATED_REQUEST_ROWS_PER_ENRICHMENT} related request rows. Narrow the report filters.`,
				);
			}
			const event = mapReportTransaction(transaction);
			if (event != null) {
				if (event.txHash != null && new Set(event.relatedPaymentKeys ?? []).size > 1) {
					requestStateAmbiguousHashes.add(event.txHash);
				}
				accumulateTransactionEvidence(evidence, event);
			}
		}
	}
	if (scalarTransactions.some((transaction) => !hydratedTransactionIds.has(transaction.id))) {
		throw createHttpError(500, 'Report transaction evidence snapshot is incomplete.');
	}
	const mergedEventByHash = new Map<string, ReportTransactionEvent>();
	for (const [txHash, accumulator] of evidence) {
		assertReportQueryActive(signal);
		mergedEventByHash.set(txHash, materializeTransactionEvidence(txHash, accumulator));
	}

	return records.map((record) => {
		assertReportQueryActive(signal);
		const evidence: ReportTransactionEvent[] = [];
		for (const transaction of record.transactions) {
			assertReportQueryActive(signal);
			if (transaction.txHash == null) {
				evidence.push({ ...transaction, relatedPaymentKeysComplete: false });
				continue;
			}
			const sameHashEvent = mergedEventByHash.get(transaction.txHash);
			evidence.push(
				sameHashEvent == null
					? { ...transaction, relatedPaymentKeysComplete: false }
					: {
							...transaction,
							newOnChainState: requestStateAmbiguousHashes.has(transaction.txHash) ? null : transaction.newOnChainState,
							fees: sameHashEvent.fees,
							relatedRequestKeys: sameHashEvent.relatedRequestKeys,
							relatedPaymentKeys: sameHashEvent.relatedPaymentKeys,
							relatedPaymentKeysComplete: sameHashEvent.relatedPaymentKeysComplete,
						},
			);
		}
		const merged = mergeReportTransactions(evidence);
		return {
			...record,
			transactions: merged,
			feeAllocationScope: reportFeeAllocationScope(merged),
			feeComponentScope: reportFeeComponentScope(merged, record.blockchainIdentifier),
		};
	});
}
