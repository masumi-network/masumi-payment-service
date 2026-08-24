import createHttpError from 'http-errors';
import type { AuthContext } from '@masumi/payment-core/auth';
import { prisma } from '@masumi/payment-core/db';
import { HotWalletType, type Prisma } from '@/generated/prisma/client';
import type { ReportFilterInput, ReportSummaryInput, ReportTransactionsInput } from '@/routes/api/reports/schemas';
import {
	listAccessibleReportFacets,
	resolveAccessibleReportSource,
	resolveAuthorizedManagedWalletIds,
	type ReportAccessClient,
} from './access';
import {
	createReportCursorSnapshot,
	createReportFilterFingerprint,
	decodeReportCursor,
	encodeReportCursor,
	queryReportFeeComponentClosure,
	queryReportPage,
	type ReportCursorPositions,
	type ReportCursorSnapshot,
	type ReportQueryClient,
	type ReportQueryFilters,
} from './query';
import {
	buildReportRow,
	getReportRowWarnings,
	serializeReportRow,
	type ReportRow,
	type ReportWarning,
} from './records';
import { aggregateReportRows, serializeReportAggregateResult } from './aggregate';
import { assignCompleteReportFeeReconciliation } from './aggregate-fees';
import { createReportLoadBudget, type ReportLoadBudgetLimits } from './load-budget';

const REPORT_AGGREGATE_PAGE_SIZE = 100;
const REPORT_MAX_AGGREGATE_ROWS = 50_000;
const REPORT_AGGREGATE_TIMEOUT_MS = 30_000;
const REPORT_SUMMARY_TRANSACTION_TIMEOUT_MS = REPORT_AGGREGATE_TIMEOUT_MS + 5_000;
const REPORT_PAGE_TRANSACTION_TIMEOUT_MS = 15_000;
const REPORT_TRANSACTION_MAX_WAIT_MS = 5_000;
const REPORT_PAGE_FEE_CONTEXT_MAX_SERIALIZED_BYTES = 32 * 1024 * 1024;

const PAGINATED_SNAPSHOT_WARNING: ReportWarning = {
	code: 'PAGINATED_REPORT_MONOTONIC_SNAPSHOT',
	message:
		'Paginated JSON is monotonic, not a database snapshot. Requests changed after asOf are excluded because historical row values are not stored.',
	rowId: null,
};

type ReportSource = Awaited<ReturnType<typeof resolveAccessibleReportSource>>;
type ReportDatabaseClient = ReportAccessClient & ReportQueryClient;

type AggregateLoadLimits = ReportLoadBudgetLimits & {
	pageSize?: number;
	maxRows?: number;
	timeoutMilliseconds?: number;
	now?: () => number;
};

function unique<T>(values: readonly T[]): T[] {
	return Array.from(new Set(values));
}

function rejectUnsupportedFiat(input: ReportFilterInput): void {
	if (input.fiat != null) {
		throw createHttpError(501, 'Fiat conversion is not available for transaction reports yet');
	}
}

function paymentSourceMetadata(source: ReportSource, snapshot?: ReportCursorSnapshot | null) {
	return {
		id: source.id,
		network: source.network,
		paymentSourceType: snapshot?.paymentSourceType ?? source.paymentSourceType,
		feeRatePermille: snapshot?.feeRatePermille ?? source.feeRatePermille,
		smartContractAddress: source.smartContractAddress,
		deletedAt: source.deletedAt,
	};
}

function normalizedFilterMetadata(input: ReportFilterInput, authorizedManagedWalletIds: string[] | null) {
	return {
		paymentSourceId: input.paymentSourceId,
		managedWalletIds: authorizedManagedWalletIds,
		externalAddresses: unique(input.externalAddresses ?? []),
		roles: unique(input.roles),
		states: unique(input.states ?? []),
		from: input.from,
		to: input.to,
		dateBasis: input.dateBasis,
		revenueMode: input.revenueMode,
		timeZone: input.timeZone,
	};
}

function queryFilters(
	input: ReportFilterInput,
	source: ReportSource,
	authorizedManagedWalletIds: string[] | null,
	asOf: Date,
	snapshot?: ReportCursorSnapshot | null,
): ReportQueryFilters {
	return {
		paymentSourceId: source.id,
		paymentSourceType: snapshot?.paymentSourceType ?? source.paymentSourceType,
		configuredFeeRatePermille: snapshot?.feeRatePermille ?? source.feeRatePermille,
		authorizedManagedWalletIds,
		externalAddresses: unique(input.externalAddresses ?? []),
		roles: unique(input.roles),
		states: unique(input.states ?? []),
		from: input.from,
		to: input.to,
		dateBasis: input.dateBasis,
		revenueMode: input.revenueMode,
		asOf,
	};
}

async function resolveReportRequest(
	ctx: AuthContext,
	input: ReportFilterInput,
	transactionAsOf: Date,
	snapshot?: ReportCursorSnapshot | null,
	database?: ReportDatabaseClient,
) {
	const [source, authorizedManagedWalletIds] = await Promise.all([
		resolveAccessibleReportSource(ctx, input.paymentSourceId, database),
		resolveAuthorizedManagedWalletIds(ctx, input.paymentSourceId, input.managedWalletIds, database),
	]);
	const asOf = snapshot?.asOf ?? transactionAsOf;
	return {
		source,
		authorizedManagedWalletIds,
		asOf,
		filters: queryFilters(input, source, authorizedManagedWalletIds, asOf, snapshot),
	};
}

async function getReportSnapshotTime(database: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Date> {
	const [row] = await database.$queryRaw<Array<{ asOf: Date }>>`
		SELECT transaction_timestamp() AS "asOf"
	`;
	if (!(row?.asOf instanceof Date) || Number.isNaN(row.asOf.getTime())) {
		throw createHttpError(500, 'Failed to read the report database snapshot time');
	}
	return row.asOf;
}

function reportTimeout(): never {
	throw createHttpError(504, 'Report calculation timed out. Narrow the report filters.');
}

function assertReportActive(signal?: AbortSignal, deadline?: number): void {
	if (signal?.aborted || (deadline != null && Date.now() >= deadline)) reportTimeout();
}

function isPrismaTimeoutError(error: unknown): boolean {
	if (typeof error !== 'object' || error == null || !('code' in error)) return false;
	const code = (error as { code?: unknown }).code;
	if (code === 'P2024') return true;
	if (code !== 'P2028' || !('message' in error)) return false;
	const message = (error as { message?: unknown }).message;
	return typeof message === 'string' && /(?:timed?\s*out|timeout|expired transaction|given time)/i.test(message);
}

async function runReportTransaction<T>(
	work: (transaction: Prisma.TransactionClient) => Promise<T>,
	timeout: number,
): Promise<T> {
	try {
		return await prisma.$transaction(work, {
			isolationLevel: 'RepeatableRead',
			timeout,
			maxWait: REPORT_TRANSACTION_MAX_WAIT_MS,
		});
	} catch (error) {
		if (isPrismaTimeoutError(error)) reportTimeout();
		throw error;
	}
}

function reportMetadata(
	input: ReportFilterInput,
	source: ReportSource,
	authorizedManagedWalletIds: string[] | null,
	asOf: Date,
	warnings: ReportWarning[],
	snapshot?: ReportCursorSnapshot | null,
) {
	return {
		generatedAt: new Date(),
		asOf,
		paymentSource: paymentSourceMetadata(source, snapshot),
		filters: normalizedFilterMetadata(input, authorizedManagedWalletIds),
		warnings,
	};
}

function summarizeWarnings(warnings: readonly ReportWarning[]): ReportWarning[] {
	const byCode = new Map<string, ReportWarning>();
	for (const warning of warnings) {
		if (!byCode.has(warning.code)) byCode.set(warning.code, { ...warning, rowId: null });
	}
	return Array.from(byCode.values());
}

export async function getReportFacets(ctx: AuthContext, signal?: AbortSignal) {
	assertReportActive(signal);
	const facets = await listAccessibleReportFacets(ctx);
	assertReportActive(signal);
	return {
		paymentSources: facets.paymentSources.map((source) => paymentSourceMetadata(source)),
		managedWallets: facets.managedWallets.map((wallet) => {
			if (wallet.type !== HotWalletType.Selling && wallet.type !== HotWalletType.Purchasing) {
				throw createHttpError(500, 'Report facets returned an unsupported managed wallet type');
			}
			return {
				id: wallet.id,
				paymentSourceId: wallet.paymentSourceId,
				type: wallet.type,
				walletAddress: wallet.walletAddress,
				walletVkey: wallet.walletVkey,
				collectionAddress: wallet.collectionAddress,
				note: wallet.note,
				deletedAt: wallet.deletedAt,
			};
		}),
	};
}

export async function getTransactionsReport(input: ReportTransactionsInput, ctx: AuthContext, signal?: AbortSignal) {
	const deadline = Date.now() + REPORT_PAGE_TRANSACTION_TIMEOUT_MS;
	assertReportActive(signal, deadline);
	rejectUnsupportedFiat(input);
	const decodedCursor = decodeReportCursor(input.cursor);
	if (decodedCursor.snapshot != null && decodedCursor.snapshot.paymentSourceId !== input.paymentSourceId) {
		throw createHttpError(400, 'Report cursor does not match the requested filters');
	}
	const { request, snapshot, page, feeContextRecords } = await runReportTransaction(async (transaction) => {
		assertReportActive(signal, deadline);
		const transactionAsOf = await getReportSnapshotTime(transaction);
		const request = await resolveReportRequest(ctx, input, transactionAsOf, decodedCursor.snapshot, transaction);
		const filterFingerprint = createReportFilterFingerprint({ ...request.filters, timeZone: input.timeZone });
		if (decodedCursor.snapshot != null && decodedCursor.snapshot.filterFingerprint !== filterFingerprint) {
			throw createHttpError(400, 'Report cursor does not match the requested filters');
		}
		const snapshot = decodedCursor.snapshot ?? createReportCursorSnapshot(request.filters, filterFingerprint);
		const page = await queryReportPage(request.filters, decodedCursor.positions, input.limit, transaction, signal);
		const feeContextRecords =
			input.cursor != null || page.nextCursor != null
				? await queryReportFeeComponentClosure(page.records, request.filters, transaction, { signal })
				: page.records;
		assertReportActive(signal, deadline);
		return { request, snapshot, page, feeContextRecords };
	}, REPORT_PAGE_TRANSACTION_TIMEOUT_MS);
	assertReportActive(signal, deadline);
	const { asOf } = request;
	const metricWindow = { dateBasis: input.dateBasis, from: input.from, to: input.to };
	const consumeFeeContextBudget = createReportLoadBudget({
		maxSerializedBytes: REPORT_PAGE_FEE_CONTEXT_MAX_SERIALIZED_BYTES,
	});
	const builtFeeContextRows: ReportRow[] = [];
	for (const record of feeContextRecords) {
		assertReportActive(signal, deadline);
		const row = buildReportRow(record, input.revenueMode, asOf, metricWindow);
		consumeFeeContextBudget(record, row);
		builtFeeContextRows.push(row);
	}
	const feeContextRows = assignCompleteReportFeeReconciliation(
		builtFeeContextRows,
		input.dateBasis,
		input.from,
		input.to,
		() => assertReportActive(signal, deadline),
	);
	const feeContextRowsByRequest = new Map(feeContextRows.map((row) => [`${row.requestType}:${row.id}`, row] as const));
	const rows: ReportRow[] = [];
	for (const record of page.records) {
		assertReportActive(signal, deadline);
		const row = feeContextRowsByRequest.get(`${record.requestType}:${record.id}`);
		if (row == null) throw createHttpError(500, 'Report fee context omitted a requested row');
		rows.push(row);
	}
	assertReportActive(signal, deadline);
	const warnings = rows.flatMap(getReportRowWarnings);
	if (input.cursor != null || page.nextCursor != null) warnings.push(PAGINATED_SNAPSHOT_WARNING);
	return {
		rows: rows.map(serializeReportRow),
		page: {
			nextCursor: page.nextCursor == null ? null : encodeReportCursor({ positions: page.nextCursor, snapshot }),
			hasMore: page.nextCursor != null,
		},
		metadata: reportMetadata(input, request.source, request.authorizedManagedWalletIds, asOf, warnings, snapshot),
	};
}

function cursorPositionsKey(cursor: ReportCursorPositions): string {
	return JSON.stringify({
		Buyer: cursor.Buyer == null ? null : { createdAt: cursor.Buyer.createdAt.toISOString(), id: cursor.Buyer.id },
		Seller: cursor.Seller == null ? null : { createdAt: cursor.Seller.createdAt.toISOString(), id: cursor.Seller.id },
	});
}

export async function loadAllReportRows(
	filters: ReportQueryFilters,
	limits: AggregateLoadLimits = {},
	database?: ReportQueryClient,
	signal?: AbortSignal,
): Promise<ReportRow[]> {
	const pageSize = limits.pageSize ?? REPORT_AGGREGATE_PAGE_SIZE;
	const maxRows = limits.maxRows ?? REPORT_MAX_AGGREGATE_ROWS;
	const timeoutMilliseconds = limits.timeoutMilliseconds ?? REPORT_AGGREGATE_TIMEOUT_MS;
	const now = limits.now ?? Date.now;
	const deadline = now() + timeoutMilliseconds;
	const seenCursors = new Set<string>();
	const rows: ReportRow[] = [];
	const consumeBudget = createReportLoadBudget(limits);
	let cursor: ReportCursorPositions = { Buyer: null, Seller: null };

	while (true) {
		if (signal?.aborted || now() >= deadline) {
			throw createHttpError(504, 'Report calculation timed out. Narrow the report filters.');
		}
		const page = await queryReportPage(filters, cursor, pageSize, database, signal);
		if (signal?.aborted || now() >= deadline) {
			throw createHttpError(504, 'Report calculation timed out. Narrow the report filters.');
		}
		if (rows.length + page.records.length > maxRows) {
			throw createHttpError(413, `Report exceeds ${maxRows} rows. Narrow the report filters.`);
		}
		const metricWindow = { dateBasis: filters.dateBasis, from: filters.from, to: filters.to };
		for (const record of page.records) {
			if (signal?.aborted || now() >= deadline) reportTimeout();
			const row = buildReportRow(record, filters.revenueMode, filters.asOf, metricWindow);
			consumeBudget(record, row);
			rows.push(row);
		}
		if (page.nextCursor == null) {
			const reconciled = assignCompleteReportFeeReconciliation(
				rows,
				filters.dateBasis,
				filters.from,
				filters.to,
				() => {
					if (signal?.aborted || now() >= deadline) reportTimeout();
				},
			);
			if (signal?.aborted || now() >= deadline) reportTimeout();
			return reconciled;
		}

		const encodedCursor = cursorPositionsKey(page.nextCursor);
		if (seenCursors.has(encodedCursor)) {
			throw createHttpError(500, 'Report pagination did not advance');
		}
		seenCursors.add(encodedCursor);
		cursor = page.nextCursor;
	}
}

async function loadCompleteReportData(input: ReportSummaryInput, ctx: AuthContext, signal?: AbortSignal) {
	assertReportActive(signal);
	rejectUnsupportedFiat(input);
	const deadline = Date.now() + REPORT_AGGREGATE_TIMEOUT_MS;
	const { request, rows } = await runReportTransaction(async (transaction) => {
		assertReportActive(signal, deadline);
		const transactionAsOf = await getReportSnapshotTime(transaction);
		const request = await resolveReportRequest(ctx, input, transactionAsOf, null, transaction);
		const remainingMilliseconds = deadline - Date.now();
		if (remainingMilliseconds <= 0) reportTimeout();
		const rows = await loadAllReportRows(
			request.filters,
			{ timeoutMilliseconds: remainingMilliseconds },
			transaction,
			signal,
		);
		return { request, rows };
	}, REPORT_SUMMARY_TRANSACTION_TIMEOUT_MS);
	assertReportActive(signal, deadline);
	const aggregate = aggregateReportRows(rows, input.bucket, input.timeZone, input.from, input.to, input.dateBasis, () =>
		assertReportActive(signal, deadline),
	);
	assertReportActive(signal, deadline);
	const rowWarnings: ReportWarning[] = [];
	for (const row of rows) {
		assertReportActive(signal, deadline);
		rowWarnings.push(...getReportRowWarnings(row));
	}
	const warnings = summarizeWarnings([...rowWarnings, ...aggregate.warnings]);
	assertReportActive(signal, deadline);
	return {
		rows,
		aggregate,
		metadata: reportMetadata(input, request.source, request.authorizedManagedWalletIds, request.asOf, warnings),
		deadline,
	};
}

export async function getCompleteReportData(input: ReportSummaryInput, ctx: AuthContext, signal?: AbortSignal) {
	const { deadline: _deadline, ...data } = await loadCompleteReportData(input, ctx, signal);
	return data;
}

export async function getSummaryReport(input: ReportSummaryInput, ctx: AuthContext, signal?: AbortSignal) {
	const { aggregate, metadata, deadline } = await loadCompleteReportData(input, ctx, signal);
	const serialized = serializeReportAggregateResult(aggregate);
	assertReportActive(signal, deadline);
	return {
		totals: serialized.totals,
		wallets: serialized.wallets,
		history: serialized.history,
		bucket: serialized.bucket,
		metadata,
	};
}
