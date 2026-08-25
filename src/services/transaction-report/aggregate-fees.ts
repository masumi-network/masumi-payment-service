import type { ReportMetricWindow, ReportRow } from './records';
import { groupReportRowsByPayment } from './row-groups';
import { feeShareForPaymentKeys, isSharedFee } from './fee-split';
import { mergeReportTransactions } from './timestamps';
import { NO_REPORT_CHECKPOINT, runReportCheckpoint, type ReportCheckpoint } from './checkpoint';

type ReportDateBasis = ReportMetricWindow['dateBasis'];

export type CoveredTransaction = {
	fee: bigint;
	blockTime: Date | null;
	paymentKeys: readonly string[];
};

export type FeeComponent = {
	paymentKeys: readonly string[];
	transactions: CoveredTransaction[];
	total: bigint;
	admin: bigint | null;
	isTotalComplete: boolean;
	isAdminComplete: boolean;
	/** True when a shared transaction fee had to be divided by an equal share. */
	isEstimated: boolean;
	buyerActorFees: bigint;
	sellerActorFees: bigint;
	actorFees: bigint;
	isActorComplete: boolean;
};

export type FeeAnalysis = {
	components: FeeComponent[];
	actor: bigint;
	total: bigint;
	admin: bigint;
	actorCompleteness: 'complete' | 'partial';
	totalCompleteness: 'complete' | 'partial';
	adminCompleteness: 'complete' | 'partial';
};

function dateFromBlockTime(blockTime: number | null): Date | null {
	if (blockTime == null || !Number.isSafeInteger(blockTime) || blockTime < 0) return null;
	const value = new Date(blockTime * 1000);
	return Number.isNaN(value.getTime()) ? null : value;
}

function uniqueSorted(values: readonly string[] | null | undefined): string[] {
	return values == null ? [] : Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

export function analyzeReportFees(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
	checkpoint: ReportCheckpoint = NO_REPORT_CHECKPOINT,
): FeeAnalysis {
	checkpoint();
	const selectedPaymentKeys = new Set(rows.map((row) => row.blockchainIdentifier));
	const parent = new Map(Array.from(selectedPaymentKeys, (key) => [key, key]));
	const totalEvidence = new Map(Array.from(selectedPaymentKeys, (key) => [key, true]));
	const hasKnownCohortMembership = new Map(
		Array.from(selectedPaymentKeys, (key) => [key, dateBasis !== 'FundsLockedAt']),
	);
	if (dateBasis === 'FundsLockedAt') {
		for (const [index, row] of rows.entries()) {
			runReportCheckpoint(index, checkpoint);
			if (
				row.timestamps.fundsLockedAt != null &&
				row.timestamps.fundsLockedAt.getTime() >= from.getTime() &&
				row.timestamps.fundsLockedAt.getTime() < to.getTime()
			) {
				hasKnownCohortMembership.set(row.blockchainIdentifier, true);
			}
		}
	}
	const mergedTransactions = mergeReportTransactions(rows.flatMap((row) => row.transactions));
	const confirmedPaymentKeys = new Set(
		mergedTransactions
			.filter((transaction) => transaction.status === 'Confirmed')
			.flatMap((transaction) => uniqueSorted(transaction.relatedPaymentKeys))
			.filter((key) => selectedPaymentKeys.has(key)),
	);
	for (const [index, row] of rows.entries()) {
		runReportCheckpoint(index, checkpoint);
		if (row.onChainState != null && !confirmedPaymentKeys.has(row.blockchainIdentifier)) {
			totalEvidence.set(row.blockchainIdentifier, false);
		}
		if (!hasKnownCohortMembership.get(row.blockchainIdentifier)) {
			totalEvidence.set(row.blockchainIdentifier, false);
		}
	}
	const find = (key: string): string => {
		let root = key;
		while (parent.get(root) !== root) root = parent.get(root)!;
		parent.set(key, root);
		return root;
	};
	const union = (keys: readonly string[]) => {
		for (const key of keys.slice(1)) parent.set(find(key), find(keys[0]));
	};
	let hasUnknownTotalEvidence = false;
	/** Requests whose fee figures came from an equal share rather than a reading. */
	const sharedFeeKeys = new Set<string>();
	const covered: CoveredTransaction[] = [];
	for (const [index, transaction] of mergedTransactions.entries()) {
		runReportCheckpoint(index, checkpoint);
		const blockTime = dateFromBlockTime(transaction.blockTime);
		if (
			dateBasis === 'RevenueRecognizedAt' &&
			blockTime != null &&
			(blockTime.getTime() < from.getTime() || blockTime.getTime() >= to.getTime())
		) {
			continue;
		}
		if (transaction.status !== 'Confirmed' && transaction.status != null) continue;
		const paymentKeys = uniqueSorted(transaction.relatedPaymentKeys);
		const selectedRelatedKeys = paymentKeys.filter((key) => selectedPaymentKeys.has(key));
		const markIncomplete = (target: Map<string, boolean>) => {
			if (selectedRelatedKeys.length === 0) {
				hasUnknownTotalEvidence = true;
			} else for (const key of selectedRelatedKeys) target.set(key, false);
		};
		const isCoreComplete =
			transaction.status === 'Confirmed' &&
			transaction.txHash != null &&
			transaction.fees != null &&
			transaction.fees >= 0n &&
			(dateBasis !== 'RevenueRecognizedAt' || blockTime != null);
		// Without the full list of settled requests there is no denominator, so
		// no share of this fee can be worked out at all.
		const hasKnownBatch = transaction.relatedPaymentKeysComplete !== false && paymentKeys.length > 0;
		if (!isCoreComplete) {
			markIncomplete(totalEvidence);
			continue;
		}
		if (transaction.fees === 0n) continue;
		if (selectedRelatedKeys.some((key) => !hasKnownCohortMembership.get(key))) {
			markIncomplete(totalEvidence);
			continue;
		}
		if (!hasKnownBatch) {
			markIncomplete(totalEvidence);
			continue;
		}
		// The report owes only the shares of the requests it holds. A batch can
		// reach outside the filter, and those shares stay outside the report.
		const share = feeShareForPaymentKeys(transaction.fees, paymentKeys, selectedPaymentKeys);
		// A batch that sits wholly inside the report still adds up to the fee the
		// chain charged, so the total stays exact. Only a part of a batch is an
		// estimate, because the rest of the fee belongs to requests the report
		// cannot see. See ./fee-split.
		//
		// This runs before the zero-share exit. A share can round to zero when a
		// batch holds more requests than the fee holds lovelace, and that share is
		// still apportioned, not read. Exiting first would report it as exact.
		if (isSharedFee(paymentKeys) && selectedRelatedKeys.length !== paymentKeys.length) {
			for (const key of selectedRelatedKeys) sharedFeeKeys.add(key);
		}
		if (share === 0n) continue;
		if (selectedRelatedKeys.length > 1) union(selectedRelatedKeys);
		covered.push({ fee: share, blockTime, paymentKeys: selectedRelatedKeys });
	}

	const rowsByPayment = groupReportRowsByPayment(rows, checkpoint);
	const paymentsByRoot = new Map<string, string[]>();
	let paymentIndex = 0;
	for (const key of selectedPaymentKeys) {
		runReportCheckpoint(paymentIndex, checkpoint);
		paymentIndex += 1;
		const root = find(key);
		const payments = paymentsByRoot.get(root);
		if (payments == null) paymentsByRoot.set(root, [key]);
		else payments.push(key);
	}
	const coveredByRoot = new Map<string, CoveredTransaction[]>();
	for (const [index, transaction] of covered.entries()) {
		runReportCheckpoint(index, checkpoint);
		const root = find(transaction.paymentKeys[0]);
		const transactions = coveredByRoot.get(root);
		if (transactions == null) coveredByRoot.set(root, [transaction]);
		else transactions.push(transaction);
	}
	const components = Array.from(paymentsByRoot, ([root, paymentKeys], index): FeeComponent => {
		runReportCheckpoint(index, checkpoint);
		const transactions = coveredByRoot.get(root) ?? [];
		let buyerActorFees = 0n;
		let sellerActorFees = 0n;
		let isActorComplete = true;
		for (const paymentKey of paymentKeys) {
			const paymentRows = rowsByPayment.get(paymentKey) ?? [];
			const ownerRows = paymentRows.filter((row) => row.isFeeReconciliationOwner);
			const evidenceRows = ownerRows.length === 1 ? ownerRows : paymentRows;
			for (const field of ['buyerCardanoFees', 'sellerCardanoFees'] as const) {
				const values = new Set(evidenceRows.map((row) => row.cardanoFeeReconciliation[field].toString()));
				if (values.size !== 1) isActorComplete = false;
				else if (field === 'buyerCardanoFees') buyerActorFees += BigInt([...values][0]);
				else sellerActorFees += BigInt([...values][0]);
			}
			if (evidenceRows.some((row) => row.actorCardanoFeeAllocation.completeness === 'partial')) {
				isActorComplete = false;
			}
		}
		const actorFees = buyerActorFees + sellerActorFees;
		const total = transactions.reduce((sum, transaction) => sum + transaction.fee, 0n);
		// An estimated figure is still a figure. It is kept, and reported as
		// partial, rather than dropped for "not known".
		const isEstimated = paymentKeys.some((key) => sharedFeeKeys.has(key));
		const isTotalKnown = paymentKeys.every((key) => totalEvidence.get(key));
		const canDeriveAdmin = isTotalKnown && isActorComplete && total >= actorFees;
		return {
			paymentKeys,
			transactions,
			total,
			admin: canDeriveAdmin ? total - actorFees : null,
			isTotalComplete: isTotalKnown && !isEstimated,
			isAdminComplete: canDeriveAdmin && !isEstimated,
			isEstimated,
			buyerActorFees,
			sellerActorFees,
			actorFees,
			isActorComplete,
		};
	});
	const actor = components.reduce((sum, component) => sum + component.actorFees, 0n);
	const total = covered.reduce((sum, transaction) => sum + transaction.fee, 0n);
	const admin = components.reduce((sum, component) => sum + (component.admin ?? 0n), 0n);
	return {
		components,
		actor,
		total,
		admin,
		actorCompleteness: components.some((component) => !component.isActorComplete) ? 'partial' : 'complete',
		totalCompleteness:
			hasUnknownTotalEvidence || components.some((component) => !component.isTotalComplete) ? 'partial' : 'complete',
		adminCompleteness:
			hasUnknownTotalEvidence || components.some((component) => !component.isAdminComplete) ? 'partial' : 'complete',
	};
}

function reportRowKey(row: ReportRow): string {
	return `${row.requestType}:${row.id}`;
}

function componentRowReconciliation(component: FeeComponent, isOwner: boolean): ReportRow['cardanoFeeReconciliation'] {
	if (!isOwner) {
		if (!component.isTotalComplete || !component.isActorComplete) {
			return {
				buyerCardanoFees: 0n,
				sellerCardanoFees: 0n,
				adminCardanoFees: null,
				totalCardanoFees: null,
				completeness: 'partial',
			};
		}
		return component.total < component.actorFees
			? {
					buyerCardanoFees: 0n,
					sellerCardanoFees: 0n,
					adminCardanoFees: null,
					totalCardanoFees: 0n,
					completeness: 'inconsistent',
				}
			: {
					buyerCardanoFees: 0n,
					sellerCardanoFees: 0n,
					adminCardanoFees: 0n,
					totalCardanoFees: 0n,
					completeness: 'complete',
				};
	}
	if (!component.isTotalComplete || !component.isActorComplete) {
		return {
			buyerCardanoFees: component.buyerActorFees,
			sellerCardanoFees: component.sellerActorFees,
			adminCardanoFees: component.admin,
			totalCardanoFees: component.total,
			completeness: 'partial',
		};
	}
	if (component.total < component.actorFees) {
		return {
			buyerCardanoFees: component.buyerActorFees,
			sellerCardanoFees: component.sellerActorFees,
			adminCardanoFees: null,
			totalCardanoFees: component.total,
			completeness: 'inconsistent',
		};
	}
	return {
		buyerCardanoFees: component.buyerActorFees,
		sellerCardanoFees: component.sellerActorFees,
		adminCardanoFees: component.admin!,
		totalCardanoFees: component.total,
		completeness: 'complete',
	};
}

export function assignCompleteReportFeeReconciliation(
	rows: readonly ReportRow[],
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
	checkpoint: ReportCheckpoint = NO_REPORT_CHECKPOINT,
): ReportRow[] {
	const analysis = analyzeReportFees(rows, dateBasis, from, to, checkpoint);
	const rowsByPayment = groupReportRowsByPayment(rows, checkpoint);
	const allocations = new Map<
		string,
		Pick<
			ReportRow,
			'actorCardanoFeeAllocation' | 'cardanoFeeReconciliation' | 'feeComponentScope' | 'isFeeReconciliationOwner'
		>
	>();
	for (const [index, component] of analysis.components.entries()) {
		runReportCheckpoint(index, checkpoint);
		const componentRows = component.paymentKeys
			.flatMap((key) => rowsByPayment.get(key) ?? [])
			.sort((left, right) => {
				const paymentComparison = left.blockchainIdentifier.localeCompare(right.blockchainIdentifier);
				if (paymentComparison !== 0) return paymentComparison;
				if (left.isFeeReconciliationOwner !== right.isFeeReconciliationOwner) {
					return left.isFeeReconciliationOwner ? -1 : 1;
				}
				return reportRowKey(left).localeCompare(reportRowKey(right));
			});
		const owner = componentRows[0];
		const completeness = componentRowReconciliation(component, true).completeness;
		for (const row of componentRows) {
			const isOwner = row === owner;
			allocations.set(reportRowKey(row), {
				isFeeReconciliationOwner: isOwner,
				feeComponentScope: completeness === 'complete' ? 'complete' : 'partial',
				// The component says nothing about whether this request's own fee
				// counter is contained by the report window, so the row keeps the
				// answer it worked out for itself.
				actorCardanoFeeAllocation: row.actorCardanoFeeAllocation,
				cardanoFeeReconciliation: componentRowReconciliation(component, isOwner),
			});
		}
	}
	return rows.map((row) => ({ ...row, ...allocations.get(reportRowKey(row)) }));
}
