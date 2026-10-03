export type ReportCheckpoint = () => void;

export const NO_REPORT_CHECKPOINT: ReportCheckpoint = () => undefined;

export function runReportCheckpoint(index: number, checkpoint: ReportCheckpoint): void {
	if (index % 256 === 0) checkpoint();
}
