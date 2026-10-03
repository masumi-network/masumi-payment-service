import type { ReportRow } from './records';
import { NO_REPORT_CHECKPOINT, runReportCheckpoint, type ReportCheckpoint } from './checkpoint';

export function groupReportRowsByPayment(
	rows: readonly ReportRow[],
	checkpoint: ReportCheckpoint = NO_REPORT_CHECKPOINT,
): Map<string, ReportRow[]> {
	const groups = new Map<string, ReportRow[]>();
	for (const [index, row] of rows.entries()) {
		runReportCheckpoint(index, checkpoint);
		const group = groups.get(row.blockchainIdentifier);
		if (group == null) groups.set(row.blockchainIdentifier, [row]);
		else group.push(row);
	}
	return groups;
}
