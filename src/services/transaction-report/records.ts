import { serializeReportAmount } from '@/utils/asset-units';
import { addAmounts, normalizeAmounts, subtractAmounts, type AtomicAmount } from './amounts';
import type { FiatRowRates } from './fiat/rates';
import {
	calculateBuyerMetrics,
	calculateSellerMetrics,
	reconcileCardanoFees,
	type PayoutCompleteness,
	type ReportOnChainState,
	type ReportPaymentSourceType,
	type RevenueMode,
} from './metrics';
import {
	getReportFeeTransactions,
	getReportSettlementEvidence,
	getReportTimestamps,
	hasConfirmedOnChainTransaction,
	hasConfirmedStateTransaction,
	sumPerRequestConfirmedTransactionFees,
	type ReportTransactionEvent,
} from './timestamps';

export type ReportRole = 'Buyer' | 'Seller';
export type ReportRequestType = 'PaymentRequest' | 'PurchaseRequest';

export type ReportManagedWallet = {
	id: string;
	walletAddress: string;
	walletVkey: string;
	collectionAddress: string | null;
	deletedAt: Date | null;
};

export type ReportMetricWindow = Readonly<{
	dateBasis: 'CreatedAt' | 'FundsLockedAt' | 'RevenueRecognizedAt';
	from: Date;
	to: Date;
}>;

type ReportCardanoFeeTiming = 'stored_cumulative' | 'accounting_allocation';

export type ReportRequestRecord = {
	id: string;
	role: ReportRole;
	requestType: ReportRequestType;
	createdAt: Date;
	blockchainIdentifier: string;
	agentIdentifier: string | null;
	agentName: string | null;
	onChainState: ReportOnChainState | null;
	metadata: string | null;
	managedWallet: ReportManagedWallet | null;
	counterpartyAddress: string | null;
	buyerReturnAddress: string | null;
	sellerReturnAddress: string | null;
	paymentSourceType: ReportPaymentSourceType;
	configuredFeeRatePermille: number;
	resultHash: string | null;
	unlockTime: bigint;
	collateralReturnLovelace: bigint | null;
	requestedFunds: readonly AtomicAmount[];
	withdrawnForBuyer: readonly AtomicAmount[];
	withdrawnForSeller: readonly AtomicAmount[];
	buyerPayoutCompleteness: PayoutCompleteness;
	sellerPayoutCompleteness: PayoutCompleteness;
	buyerCardanoFees: bigint;
	sellerCardanoFees: bigint;
	transactions: readonly ReportTransactionEvent[];
	feeAllocationScope: 'single_request' | 'shared_or_unknown';
	isFeeReconciliationOwner: boolean;
	feeComponentScope: 'complete' | 'partial';
};

export type ReportWarning = {
	code: string;
	message: string;
	rowId: string | null;
};

function assertValidMetricWindow(window: ReportMetricWindow): void {
	if (Number.isNaN(window.from.getTime()) || Number.isNaN(window.to.getTime())) {
		throw new RangeError('Report metric window dates must be valid');
	}
	if (window.to.getTime() <= window.from.getTime()) {
		throw new RangeError('Report metric window to date must be after from date');
	}
}

function isInMetricWindow(value: Date | null, window: ReportMetricWindow): boolean {
	if (value == null) return false;
	return value.getTime() >= window.from.getTime() && value.getTime() < window.to.getTime();
}

function scopeSellerMetrics(
	metrics: ReturnType<typeof calculateSellerMetrics>,
	sellerRevenueRecognizedAt: Date | null,
	fundsLockedAt: Date | null,
	window: ReportMetricWindow,
) {
	const cardanoFeeTiming: ReportCardanoFeeTiming =
		window.dateBasis === 'RevenueRecognizedAt' ? 'accounting_allocation' : 'stored_cumulative';
	if (window.dateBasis === 'CreatedAt') return { ...metrics, cardanoFeeTiming };
	const accountingDate = window.dateBasis === 'FundsLockedAt' ? fundsLockedAt : sellerRevenueRecognizedAt;
	if (isInMetricWindow(accountingDate, window)) {
		return { ...metrics, cardanoFeeTiming };
	}
	const hasUnplacedEconomicValue =
		metrics.grossRevenue == null ||
		metrics.grossRevenue.length > 0 ||
		metrics.protocolFee.completeness === 'insufficient_data' ||
		(metrics.protocolFee.amounts?.length ?? 0) > 0;
	if (accountingDate == null && hasUnplacedEconomicValue) {
		const hasUnplacedProtocolFee =
			metrics.protocolFee.completeness !== 'not_applicable' && metrics.protocolFee.provenance !== 'exact_zero';
		return {
			grossRevenue: metrics.grossRevenue == null || metrics.grossRevenue.length > 0 ? null : [],
			protocolFee: hasUnplacedProtocolFee
				? {
						...metrics.protocolFee,
						appliedRatePermille: null,
						amounts: null,
						provenance: 'insufficient_data' as const,
						basis: null,
						completeness: 'insufficient_data' as const,
					}
				: metrics.protocolFee,
			cardanoFees: [],
			netRevenue: null,
			cardanoFeeTiming,
		};
	}
	return {
		grossRevenue: [],
		protocolFee: {
			...metrics.protocolFee,
			appliedRatePermille: null,
			amounts: null,
			provenance: 'not_applicable' as const,
			basis: null,
			completeness: 'not_applicable' as const,
		},
		cardanoFees: [],
		netRevenue: [],
		cardanoFeeTiming,
	};
}

function scopeBuyerMetrics(
	metrics: ReturnType<typeof calculateBuyerMetrics>,
	timestamps: ReturnType<typeof getReportTimestamps>,
	window: ReportMetricWindow,
) {
	const cardanoFeeTiming: ReportCardanoFeeTiming =
		window.dateBasis === 'RevenueRecognizedAt' ? 'accounting_allocation' : 'stored_cumulative';
	if (window.dateBasis === 'CreatedAt') return { ...metrics, cardanoFeeTiming };
	if (window.dateBasis === 'FundsLockedAt') {
		if (isInMetricWindow(timestamps.fundsLockedAt, window)) return { ...metrics, cardanoFeeTiming };
		if (timestamps.fundsLockedAt == null) {
			const grossSpend = metrics.grossSpend == null || metrics.grossSpend.length > 0 ? null : [];
			const returnedFunds = metrics.returnedFunds == null || metrics.returnedFunds.length > 0 ? null : [];
			return {
				grossSpend,
				returnedFunds,
				cardanoFees: [],
				netSpend: grossSpend == null || returnedFunds == null || metrics.cardanoFees.length > 0 ? null : [],
				cardanoFeeTiming,
			};
		}
		return { grossSpend: [], returnedFunds: [], cardanoFees: [], netSpend: [], cardanoFeeTiming };
	}

	const hasGrossSpendInWindow = isInMetricWindow(timestamps.buyerGrossSpendAt, window);
	const hasReturnedFundsInWindow = isInMetricWindow(timestamps.buyerReturnedAt, window);
	const grossSpend = hasGrossSpendInWindow
		? metrics.grossSpend
		: timestamps.buyerGrossSpendAt == null && (metrics.grossSpend == null || metrics.grossSpend.length > 0)
			? null
			: [];
	const returnedFunds = hasReturnedFundsInWindow
		? metrics.returnedFunds
		: timestamps.buyerReturnedAt == null && (metrics.returnedFunds == null || metrics.returnedFunds.length > 0)
			? null
			: [];
	const cardanoFees = hasGrossSpendInWindow ? metrics.cardanoFees : [];
	const netSpend =
		grossSpend == null || returnedFunds == null
			? null
			: addAmounts(subtractAmounts(grossSpend, returnedFunds), cardanoFees);
	return { grossSpend, returnedFunds, cardanoFees, netSpend, cardanoFeeTiming };
}

function reconcileRowCardanoFees(
	record: ReportRequestRecord,
	transactionFees: ReturnType<typeof sumPerRequestConfirmedTransactionFees>,
	buyerCardanoFees: bigint,
	sellerCardanoFees: bigint,
	isActorFeeAllocationComplete: boolean,
	feeComponentScope: ReportRequestRecord['feeComponentScope'],
) {
	const hasExactOwnedTotal =
		record.isFeeReconciliationOwner && transactionFees.completeness === 'complete' && transactionFees.amount != null;
	if (hasExactOwnedTotal && !isActorFeeAllocationComplete) {
		return {
			buyerCardanoFees,
			sellerCardanoFees,
			adminCardanoFees: null,
			totalCardanoFees: transactionFees.amount,
			completeness: 'partial' as const,
		};
	}
	const reconciliation = reconcileCardanoFees({
		buyerCardanoFees,
		sellerCardanoFees,
		allocatedTotalCardanoFees: hasExactOwnedTotal ? transactionFees.amount : null,
		isAllocationComplete: hasExactOwnedTotal,
	});
	if (!hasExactOwnedTotal || feeComponentScope === 'complete' || reconciliation.completeness === 'inconsistent') {
		return reconciliation;
	}
	return {
		...reconciliation,
		adminCardanoFees: null,
		totalCardanoFees: transactionFees.amount,
		completeness: 'partial' as const,
	};
}

/** The states that end an escrow. Nothing is pending once one is reached. */
const SETTLED_STATES: ReadonlySet<ReportOnChainState> = new Set(['Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn']);

/**
 * Money locked in escrow that the seller has not earned yet.
 *
 * A request whose dispute window is still open earns nothing, so it lands in no
 * period and its revenue reads as unknown. That hides real money and marks the
 * whole period an estimate. Reporting it as its own figure lets the earned line
 * stay clean while the committed money stays visible.
 *
 * It is always placed on the day the funds were locked. That is the only date
 * such a request has, because the date it will be earned on has not happened.
 */
function getPendingRevenue(
	record: ReportRequestRecord,
	timestamps: ReturnType<typeof getReportTimestamps>,
	window: ReportMetricWindow,
): AtomicAmount[] {
	if (record.role !== 'Seller') return [];
	if (record.onChainState == null || SETTLED_STATES.has(record.onChainState)) return [];
	if (record.onChainState === 'FundsOrDatumInvalid') return [];
	// Without a confirmed lock there is no proof the money reached the escrow,
	// and without a lock date there is no period to put it in.
	if (timestamps.fundsLockedAt == null) return [];
	// Already earned, so it belongs to the revenue line instead.
	if (timestamps.sellerRevenueRecognizedAt != null) return [];
	if (!isInMetricWindow(timestamps.fundsLockedAt, window)) return [];
	return normalizeAmounts(record.requestedFunds);
}

function getRowFeeComponentScope(
	record: ReportRequestRecord,
	window: ReportMetricWindow,
): ReportRequestRecord['feeComponentScope'] {
	const hasIncompleteTransaction = getReportFeeTransactions(record.transactions, window)
		.filter((transaction) => transaction.status === 'Confirmed' && transaction.fees !== 0n)
		.some((transaction) => {
			if (transaction.relatedPaymentKeysComplete === false) return true;
			const paymentKeys = Array.from(new Set(transaction.relatedPaymentKeys ?? []));
			return paymentKeys.length !== 1 || paymentKeys[0] !== record.blockchainIdentifier;
		});
	return hasIncompleteTransaction ? 'partial' : 'complete';
}

/**
 * Is every fee this request will ever pay inside the report window?
 *
 * The stored actor fee counters are lifetime totals for a request, so a report
 * can only claim them exactly when the whole life of the request falls inside
 * its own dates. That needs a settled state, so no later transaction can add to
 * the counter, a confirmed lock so the earliest fee is on record at all, and a
 * first and last confirmed transaction that both sit in the window, so no
 * earlier transaction is being dragged in from another period.
 */
function isActorFeeLifetimeInWindow(
	record: ReportRequestRecord,
	window: ReportMetricWindow,
	hasConfirmedFundsLockedTransaction: boolean,
): boolean {
	if (record.onChainState == null || !SETTLED_STATES.has(record.onChainState)) return false;
	if (!hasConfirmedFundsLockedTransaction) return false;
	const times: number[] = [];
	for (const transaction of record.transactions) {
		if (transaction.status !== 'Confirmed' || transaction.txHash == null) continue;
		const blockTime = transaction.blockTime;
		if (blockTime == null || !Number.isSafeInteger(blockTime) || blockTime < 0) return false;
		times.push(blockTime * 1000);
	}
	if (times.length === 0) return false;
	return (
		isInMetricWindow(new Date(Math.min(...times)), window) && isInMetricWindow(new Date(Math.max(...times)), window)
	);
}

export function buildReportRow(
	record: ReportRequestRecord,
	revenueMode: RevenueMode,
	asOf: Date,
	window: ReportMetricWindow,
) {
	assertValidMetricWindow(window);
	const hasConfirmedTransaction = hasConfirmedOnChainTransaction(record.transactions);
	const hasConfirmedFundsLockedTransaction = hasConfirmedStateTransaction(record.transactions, 'FundsLocked');
	const hasConfirmedCurrentStateTransaction =
		record.onChainState != null && hasConfirmedStateTransaction(record.transactions, record.onChainState);
	const metricInput = {
		onChainState: record.onChainState,
		paymentSourceType: record.paymentSourceType,
		configuredFeeRatePermille: record.configuredFeeRatePermille,
		unlockTime: record.unlockTime,
		asOfTime: BigInt(asOf.getTime()),
		hasConfirmedFundsLockedTransaction,
		hasConfirmedCurrentStateTransaction,
		requestedFunds: record.requestedFunds,
		withdrawnForBuyer: record.withdrawnForBuyer,
		withdrawnForSeller: record.withdrawnForSeller,
		buyerPayoutCompleteness: record.buyerPayoutCompleteness,
		sellerPayoutCompleteness: record.sellerPayoutCompleteness,
		collateralReturnLovelace: record.collateralReturnLovelace,
		buyerCardanoFees: record.buyerCardanoFees,
		sellerCardanoFees: record.sellerCardanoFees,
	};
	const settlement = getReportSettlementEvidence(record.transactions);
	const timestamps = getReportTimestamps({
		createdAt: record.createdAt,
		onChainState: record.onChainState,
		resultHash: record.resultHash,
		unlockTime: record.unlockTime,
		asOfTime: BigInt(asOf.getTime()),
		revenueMode,
		transactions: record.transactions,
	});
	const hasKnownFundsLockedMembership =
		window.dateBasis !== 'FundsLockedAt' || isInMetricWindow(timestamps.fundsLockedAt, window);
	const transactionFees =
		!hasKnownFundsLockedMembership || (record.onChainState != null && !hasConfirmedTransaction)
			? ({ amount: null, completeness: 'partial' } as const)
			: sumPerRequestConfirmedTransactionFees(
					record.transactions,
					record.feeAllocationScope,
					window,
					record.blockchainIdentifier,
				);
	const feeComponentScope = hasKnownFundsLockedMembership ? getRowFeeComponentScope(record, window) : 'partial';
	const seller =
		record.role === 'Seller'
			? scopeSellerMetrics(
					calculateSellerMetrics(metricInput, revenueMode),
					timestamps.sellerRevenueRecognizedAt,
					timestamps.fundsLockedAt,
					window,
				)
			: null;
	const buyer =
		record.role === 'Buyer' ? scopeBuyerMetrics(calculateBuyerMetrics(metricInput), timestamps, window) : null;
	const actorCardanoFeeAllocation = {
		strategy:
			window.dateBasis === 'RevenueRecognizedAt' ? ('accounting_allocation' as const) : ('lifetime_cohort' as const),
		/** Is the amount exact for the period? */
		completeness: isActorFeeLifetimeInWindow(record, window, hasConfirmedFundsLockedTransaction)
			? ('complete' as const)
			: ('partial' as const),
		/**
		 * Is the amount exact for one day of that period? Never. A request pays
		 * on the day it locks and again on the day it settles, and the counter
		 * records no split, so the whole amount goes on one accounting date.
		 */
		historyCompleteness: 'partial' as const,
		attachedAt:
			window.dateBasis !== 'RevenueRecognizedAt'
				? null
				: record.role === 'Seller'
					? timestamps.sellerRevenueRecognizedAt
					: timestamps.buyerGrossSpendAt,
	};
	const reconciliationBuyerCardanoFees =
		hasKnownFundsLockedMembership &&
		(window.dateBasis !== 'RevenueRecognizedAt' || isInMetricWindow(timestamps.buyerGrossSpendAt, window))
			? record.buyerCardanoFees
			: 0n;
	const reconciliationSellerCardanoFees =
		hasKnownFundsLockedMembership &&
		(window.dateBasis !== 'RevenueRecognizedAt' || isInMetricWindow(timestamps.sellerRevenueRecognizedAt, window))
			? record.sellerCardanoFees
			: 0n;
	const cardanoFeeReconciliation = reconcileRowCardanoFees(
		record,
		transactionFees,
		reconciliationBuyerCardanoFees,
		reconciliationSellerCardanoFees,
		false,
		feeComponentScope,
	);

	return {
		...record,
		feeComponentScope,
		timestamps,
		settlement,
		pendingRevenue: getPendingRevenue(record, timestamps, window),
		/** Filled in by the fiat pass when a currency was asked for. */
		fiatRates: null as FiatRowRates | null,
		seller,
		buyer,
		actorCardanoFeeAllocation,
		cardanoFeeReconciliation,
	};
}

export type ReportRow = ReturnType<typeof buildReportRow>;

function serializeAmounts(amounts: readonly AtomicAmount[] | null) {
	return amounts?.map(serializeReportAmount) ?? null;
}

export function serializeReportRow(row: ReportRow) {
	return {
		id: row.id,
		role: row.role,
		requestType: row.requestType,
		createdAt: row.createdAt,
		blockchainIdentifier: row.blockchainIdentifier,
		agentIdentifier: row.agentIdentifier,
		agentName: row.agentName,
		onChainState: row.onChainState,
		metadata: row.metadata,
		managedWallet: row.managedWallet,
		counterpartyAddress: row.counterpartyAddress,
		buyerReturnAddress: row.buyerReturnAddress,
		sellerReturnAddress: row.sellerReturnAddress,
		timestamps: row.timestamps,
		settlement: row.settlement,
		seller:
			row.seller == null
				? null
				: {
						grossRevenue: serializeAmounts(row.seller.grossRevenue),
						protocolFee: {
							...row.seller.protocolFee,
							amounts: serializeAmounts(row.seller.protocolFee.amounts),
						},
						cardanoFees: serializeAmounts(row.seller.cardanoFees) ?? [],
						cardanoFeeTiming: row.seller.cardanoFeeTiming,
						netRevenue: serializeAmounts(row.seller.netRevenue),
						payoutCompleteness: row.sellerPayoutCompleteness,
					},
		buyer:
			row.buyer == null
				? null
				: {
						grossSpend: serializeAmounts(row.buyer.grossSpend),
						returnedFunds: serializeAmounts(row.buyer.returnedFunds),
						cardanoFees: serializeAmounts(row.buyer.cardanoFees) ?? [],
						cardanoFeeTiming: row.buyer.cardanoFeeTiming,
						netSpend: serializeAmounts(row.buyer.netSpend),
						payoutCompleteness: row.buyerPayoutCompleteness,
					},
		// `historyCompleteness` stays internal: each history bucket already carries
		// its own completeness, so the wire would only repeat it.
		actorCardanoFeeAllocation: {
			strategy: row.actorCardanoFeeAllocation.strategy,
			completeness: row.actorCardanoFeeAllocation.completeness,
			attachedAt: row.actorCardanoFeeAllocation.attachedAt,
		},
		feeAllocationScope: row.feeAllocationScope,
		feeComponentScope: row.feeComponentScope,
		cardanoFeeReconciliation: {
			buyerCardanoFees: serializeReportAmount({
				unit: 'lovelace',
				amount: row.cardanoFeeReconciliation.buyerCardanoFees,
			}),
			sellerCardanoFees: serializeReportAmount({
				unit: 'lovelace',
				amount: row.cardanoFeeReconciliation.sellerCardanoFees,
			}),
			adminCardanoFees:
				row.cardanoFeeReconciliation.adminCardanoFees == null
					? null
					: serializeReportAmount({
							unit: 'lovelace',
							amount: row.cardanoFeeReconciliation.adminCardanoFees,
						}),
			totalCardanoFees:
				row.cardanoFeeReconciliation.totalCardanoFees == null
					? null
					: serializeReportAmount({
							unit: 'lovelace',
							amount: row.cardanoFeeReconciliation.totalCardanoFees,
						}),
			completeness: row.cardanoFeeReconciliation.completeness,
			isAggregationOwner: row.isFeeReconciliationOwner,
		},
	};
}

export function getReportRowWarnings(row: ReportRow): ReportWarning[] {
	const warnings: ReportWarning[] = [];
	if (row.seller?.protocolFee.completeness === 'reconstructed') {
		warnings.push({
			code: 'PROTOCOL_FEE_RECONSTRUCTED',
			message:
				'V1 protocol fee uses the current Payment Source rate and stored requested funds plus collateral. Historical UTxO top-ups can differ.',
			rowId: row.id,
		});
	} else if (row.seller?.protocolFee.completeness === 'insufficient_data') {
		warnings.push({
			code: 'PROTOCOL_FEE_INSUFFICIENT_DATA',
			message:
				'Confirmed exact-state evidence, chain timing, or stored V1 fee inputs are insufficient for an exact protocol fee.',
			rowId: row.id,
		});
	}
	if (row.sellerPayoutCompleteness === 'partial' || row.buyerPayoutCompleteness === 'partial') {
		warnings.push({
			code: 'DISPUTED_PAYOUT_PARTIAL',
			message:
				'Stored disputed payout data lacks complete payout provenance, cannot separate buyer collateral, or uses a different V2 return-address payment key.',
			rowId: row.id,
		});
	}
	if (row.cardanoFeeReconciliation.completeness !== 'complete') {
		warnings.push({
			code: 'CARDANO_FEE_RECONCILIATION_PARTIAL',
			message:
				'Shared transaction evidence, aggregation ownership, or incomplete actor components prevent exact per-row admin fee allocation.',
			rowId: row.id,
		});
	}
	if (row.actorCardanoFeeAllocation.completeness === 'partial') {
		warnings.push({
			code: 'ACTOR_CARDANO_FEE_EVENT_ALLOCATION_PARTIAL',
			message:
				'Buyer and seller Cardano fee counters are observed cumulative values. Exact historical actor and admin allocation is unavailable from transaction records.',
			rowId: row.id,
		});
	}
	// Only the side this row actually describes can be missing an amount. A
	// buyer row has no `seller` at all, so reading through it would report every
	// buyer row as short of evidence and put the note in every export.
	const hasUnknownAmount =
		(row.seller != null && row.seller.grossRevenue == null) ||
		(row.buyer != null && (row.buyer.grossSpend == null || row.buyer.returnedFunds == null));
	if (hasUnknownAmount) {
		warnings.push({
			code: 'ECONOMIC_METRIC_EVIDENCE_PARTIAL',
			message:
				'Confirmed state evidence, chain timing, or payout data are insufficient for one or more economic amounts.',
			rowId: row.id,
		});
	}
	return warnings;
}
