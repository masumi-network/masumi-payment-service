/**
 * Grouping a report by the wallet that carried each side of a payment.
 *
 * A wallet aggregate is the same set of metrics as the period totals, but for
 * one managed wallet in one role. Cardano fees are the hard part: a fee is paid
 * once for a batch, so it is booked to the single group that owns the batch's
 * reconciliation, and every group in an unresolved batch is marked partial.
 */
import { addAggregateMetric as addMetric } from './aggregate-amounts';
import { getReportTransactionCount } from './aggregate-counts';
import type { FeeAnalysis } from './aggregate-fees';
import { addPendingRevenue, addRoleMetrics, createAggregate } from './aggregate-rows';
import type { ReportAggregate, ReportDateBasis, ReportWalletAggregate } from './aggregate-types';
import { groupReportRowsByPayment } from './row-groups';
import type { ReportRow } from './records';
import { runReportCheckpoint, type ReportCheckpoint } from './checkpoint';

function walletGroupKey(row: ReportRow): string {
	return `${row.managedWallet == null ? 'unassigned' : `wallet:${row.managedWallet.id}`}:${row.role}`;
}

export function buildWalletAggregates(
	rows: readonly ReportRow[],
	fees: FeeAnalysis,
	dateBasis: ReportDateBasis,
	from: Date,
	to: Date,
	checkpoint: ReportCheckpoint,
): ReportWalletAggregate[] {
	const groupedRows = new Map<string, { managedWallet: ReportRow['managedWallet']; rows: ReportRow[] }>();
	for (const [index, row] of rows.entries()) {
		runReportCheckpoint(index, checkpoint);
		const key = walletGroupKey(row);
		const group = groupedRows.get(key) ?? { managedWallet: row.managedWallet, rows: [] };
		group.rows.push(row);
		groupedRows.set(key, group);
	}
	const metricsByGroup = new Map<string, ReportAggregate>();
	let groupIndex = 0;
	for (const [key, group] of groupedRows) {
		runReportCheckpoint(groupIndex, checkpoint);
		groupIndex += 1;
		const metrics = createAggregate();
		for (const [index, row] of group.rows.entries()) {
			runReportCheckpoint(index, checkpoint);
			addRoleMetrics(metrics, row);
			addPendingRevenue(metrics, row);
		}
		Object.assign(metrics, getReportTransactionCount(group.rows, dateBasis, from, to));
		metricsByGroup.set(key, metrics);
	}
	const rowsByPayment = groupReportRowsByPayment(rows, checkpoint);
	const groupsByPayment = new Map<string, string[]>();
	let paymentIndex = 0;
	for (const [paymentKey, paymentRows] of rowsByPayment) {
		runReportCheckpoint(paymentIndex, checkpoint);
		paymentIndex += 1;
		const groups = Array.from(new Set(paymentRows.map(walletGroupKey))).sort((left, right) =>
			left.localeCompare(right),
		);
		groupsByPayment.set(paymentKey, groups);
	}
	for (const [index, component] of fees.components.entries()) {
		runReportCheckpoint(index, checkpoint);
		const componentGroups = Array.from(new Set(component.paymentKeys.flatMap((key) => groupsByPayment.get(key)!)));
		const ownerGroups = Array.from(
			new Set(
				component.paymentKeys.flatMap((key) =>
					(rowsByPayment.get(key) ?? []).filter((row) => row.isFeeReconciliationOwner).map(walletGroupKey),
				),
			),
		);
		if (ownerGroups.length !== 1) {
			for (const group of componentGroups) {
				metricsByGroup.get(group)!.actorCardanoFees.completeness = 'partial';
				metricsByGroup.get(group)!.adminCardanoFees.completeness = 'partial';
				metricsByGroup.get(group)!.totalCardanoFees.completeness = 'partial';
			}
			continue;
		}
		const metrics = metricsByGroup.get(ownerGroups[0])!;
		addMetric(
			metrics.actorCardanoFees,
			component.actorFees === 0n ? [] : [{ unit: 'lovelace', amount: component.actorFees }],
			component.isActorComplete ? 'complete' : 'partial',
		);
		addMetric(
			metrics.adminCardanoFees,
			component.admin == null ? null : [{ unit: 'lovelace', amount: component.admin }],
			component.isAdminComplete ? 'complete' : 'partial',
		);
		addMetric(
			metrics.totalCardanoFees,
			component.total === 0n ? [] : [{ unit: 'lovelace', amount: component.total }],
			component.isTotalComplete ? 'complete' : 'partial',
		);
	}
	if (fees.actorCompleteness === 'partial') {
		for (const metrics of metricsByGroup.values()) metrics.actorCardanoFees.completeness = 'partial';
	}
	if (fees.totalCompleteness === 'partial') {
		for (const metrics of metricsByGroup.values()) metrics.totalCardanoFees.completeness = 'partial';
	}
	if (fees.adminCompleteness === 'partial') {
		for (const metrics of metricsByGroup.values()) metrics.adminCardanoFees.completeness = 'partial';
	}
	return Array.from(groupedRows)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, group], index) => {
			runReportCheckpoint(index, checkpoint);
			return {
				managedWallet: group.managedWallet,
				role: group.rows[0].role,
				metrics: metricsByGroup.get(key)!,
			};
		});
}
