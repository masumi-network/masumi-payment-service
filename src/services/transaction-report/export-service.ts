import createHttpError from 'http-errors';
import type { AuthContext } from '@masumi/payment-core/auth';
import { logger } from '@masumi/payment-core/logger';
import type { ReportSummaryInput } from '@/routes/api/reports/schemas';
import {
	createTotalsCsv,
	createTransactionsCsv,
	createWalletSummaryCsv,
	REPORT_CSV_MAX_BYTES,
	ReportCsvSizeLimitError,
} from './csv';
import { stageReportCsv, stageReportZip, type StagedReportArtifact } from './export-files';
import { createReportReadme } from './export-readme';
import { getCompleteReportData } from './service';

export type ReportExportKind = 'transactions' | 'wallet-summary' | 'totals' | 'zip';

const REPORT_EXPORT_TIMEOUT_MS = 30_000;

function exportTimestamp(value: Date): string {
	return value
		.toISOString()
		.replaceAll('-', '')
		.replaceAll(':', '')
		.replace(/\.\d{3}Z$/, 'Z');
}

function remainingZipCsvBytes(usedBytes: number): number {
	const remainingBytes = REPORT_CSV_MAX_BYTES - usedBytes;
	if (remainingBytes <= 0) {
		throw new ReportCsvSizeLimitError(REPORT_CSV_MAX_BYTES);
	}
	return remainingBytes;
}

function assertExportDeadline(deadline: number, signal?: AbortSignal): void {
	if (signal?.aborted || Date.now() >= deadline) {
		throw createHttpError(504, 'Report export timed out. Narrow the report filters.');
	}
}

function exportTimeoutError() {
	return createHttpError(504, 'Report export timed out. Narrow the report filters.');
}

async function awaitBeforeExportDeadline<T>(
	operation: Promise<T>,
	deadline: number,
	cleanupLateResult?: (value: T) => Promise<void>,
	signal?: AbortSignal,
): Promise<T> {
	const remainingMilliseconds = deadline - Date.now();
	const cleanLateResult = () => {
		if (cleanupLateResult == null) return;
		void operation
			.then(cleanupLateResult)
			.catch((lateError: unknown) => logger.error('Late report export cleanup failed', { error: lateError }));
	};
	if (signal?.aborted || remainingMilliseconds <= 0) {
		cleanLateResult();
		throw exportTimeoutError();
	}
	let didTimeout = false;
	let didAbort = false;
	let timeout: NodeJS.Timeout | undefined;
	let handleAbort: (() => void) | undefined;
	const timeoutResult = new Promise<never>((_resolve, reject) => {
		timeout = setTimeout(() => {
			didTimeout = true;
			reject(exportTimeoutError());
		}, remainingMilliseconds);
	});
	const abortResult = new Promise<never>((_resolve, reject) => {
		if (signal == null) return;
		handleAbort = () => {
			didAbort = true;
			reject(exportTimeoutError());
		};
		signal.addEventListener('abort', handleAbort, { once: true });
		if (signal.aborted) handleAbort();
	});
	try {
		return await Promise.race([operation, timeoutResult, abortResult]);
	} catch (error) {
		if (didTimeout || didAbort) cleanLateResult();
		throw error;
	} finally {
		if (timeout != null) clearTimeout(timeout);
		if (handleAbort != null) signal?.removeEventListener('abort', handleAbort);
	}
}

async function returnStagedArtifactBeforeDeadline(
	artifact: StagedReportArtifact,
	deadline: number,
	signal?: AbortSignal,
): Promise<StagedReportArtifact> {
	if (!signal?.aborted && Date.now() < deadline) return artifact;
	await artifact.cleanup();
	throw createHttpError(504, 'Report export timed out. Narrow the report filters.');
}

export async function createReportExport(
	input: ReportSummaryInput,
	ctx: AuthContext,
	kind: ReportExportKind,
	signal?: AbortSignal,
	trackPendingWork?: (work: Promise<unknown>) => void,
): Promise<StagedReportArtifact> {
	if (signal?.aborted) throw exportTimeoutError();
	const deadline = Date.now() + REPORT_EXPORT_TIMEOUT_MS;
	const reportOperation = getCompleteReportData(input, ctx, signal);
	trackPendingWork?.(reportOperation);
	const report = await awaitBeforeExportDeadline(reportOperation, deadline, undefined, signal);
	assertExportDeadline(deadline, signal);
	const timestamp = exportTimestamp(report.metadata.generatedAt);
	const csvMetadata = {
		...report.metadata,
		requestedBucket: input.bucket,
		bucket: report.aggregate.bucket,
	};

	try {
		if (kind === 'transactions') {
			const csv = createTransactionsCsv(report.rows, csvMetadata);
			assertExportDeadline(deadline, signal);
			const stageOperation = stageReportCsv(csv, `masumi-transactions-${timestamp}`);
			trackPendingWork?.(stageOperation);
			const artifact = await awaitBeforeExportDeadline(stageOperation, deadline, (value) => value.cleanup(), signal);
			return returnStagedArtifactBeforeDeadline(artifact, deadline, signal);
		}
		if (kind === 'wallet-summary') {
			const csv = createWalletSummaryCsv(report.aggregate, csvMetadata);
			assertExportDeadline(deadline, signal);
			const stageOperation = stageReportCsv(csv, `masumi-wallet-summary-${timestamp}`);
			trackPendingWork?.(stageOperation);
			const artifact = await awaitBeforeExportDeadline(stageOperation, deadline, (value) => value.cleanup(), signal);
			return returnStagedArtifactBeforeDeadline(artifact, deadline, signal);
		}
		if (kind === 'totals') {
			const csv = createTotalsCsv(report.aggregate, csvMetadata);
			assertExportDeadline(deadline, signal);
			const stageOperation = stageReportCsv(csv, `masumi-totals-${timestamp}`);
			trackPendingWork?.(stageOperation);
			const artifact = await awaitBeforeExportDeadline(stageOperation, deadline, (value) => value.cleanup(), signal);
			return returnStagedArtifactBeforeDeadline(artifact, deadline, signal);
		}

		const transactions = createTransactionsCsv(report.rows, csvMetadata, {
			maxBytes: REPORT_CSV_MAX_BYTES,
		});
		assertExportDeadline(deadline, signal);
		const walletSummary = createWalletSummaryCsv(report.aggregate, csvMetadata, {
			maxBytes: remainingZipCsvBytes(transactions.byteLength),
		});
		assertExportDeadline(deadline, signal);
		const totals = createTotalsCsv(report.aggregate, csvMetadata, {
			maxBytes: remainingZipCsvBytes(transactions.byteLength + walletSummary.byteLength),
		});
		assertExportDeadline(deadline, signal);
		if (transactions.byteLength + walletSummary.byteLength + totals.byteLength > REPORT_CSV_MAX_BYTES) {
			throw new ReportCsvSizeLimitError(REPORT_CSV_MAX_BYTES);
		}

		const stageOperation = stageReportZip(
			{ readme: createReportReadme(csvMetadata), transactions, walletSummary, totals },
			`masumi-transaction-report-${timestamp}`,
		);
		trackPendingWork?.(stageOperation);
		const artifact = await awaitBeforeExportDeadline(stageOperation, deadline, (value) => value.cleanup(), signal);
		if (signal?.aborted || Date.now() >= deadline) {
			await artifact.cleanup();
			throw createHttpError(504, 'Report export timed out. Narrow the report filters.');
		}
		if (artifact.contentLength > REPORT_CSV_MAX_BYTES) {
			await artifact.cleanup();
			throw new ReportCsvSizeLimitError(REPORT_CSV_MAX_BYTES);
		}
		return artifact;
	} catch (error) {
		if (error instanceof ReportCsvSizeLimitError) {
			throw createHttpError(413, error.message);
		}
		throw error;
	}
}
