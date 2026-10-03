import { Prisma } from '@/generated/prisma/client';
import createHttpError from 'http-errors';

export type ReportMetadataReader = Pick<Prisma.TransactionClient, '$queryRaw'>;

const REPORT_MAX_METADATA_BYTES_PER_REQUEST = 64 * 1024;

type ReportMetadataRow = { id: string; metadata: string | null; isOversized: boolean };

function assertQueryActive(signal?: AbortSignal): void {
	if (signal?.aborted) throw createHttpError(504, 'Report calculation timed out. Narrow the report filters.');
}

function isReportMetadataRow(value: unknown): value is ReportMetadataRow {
	if (value == null || typeof value !== 'object') return false;
	const row = value as Partial<ReportMetadataRow>;
	return (
		typeof row.id === 'string' &&
		(row.metadata == null || typeof row.metadata === 'string') &&
		typeof row.isOversized === 'boolean'
	);
}

function metadataQuery(requestType: 'PaymentRequest' | 'PurchaseRequest', requestIds: readonly string[]): Prisma.Sql {
	const boundedColumns = Prisma.sql`
		"id",
		CASE
			WHEN COALESCE(octet_length("metadata"), 0) <= ${REPORT_MAX_METADATA_BYTES_PER_REQUEST}
			THEN "metadata"
			ELSE NULL
		END AS "metadata",
		COALESCE(octet_length("metadata"), 0) > ${REPORT_MAX_METADATA_BYTES_PER_REQUEST} AS "isOversized"
	`;
	return requestType === 'PaymentRequest'
		? Prisma.sql`SELECT ${boundedColumns} FROM "PaymentRequest" WHERE "id" IN (${Prisma.join(requestIds)})`
		: Prisma.sql`SELECT ${boundedColumns} FROM "PurchaseRequest" WHERE "id" IN (${Prisma.join(requestIds)})`;
}

export async function loadReportMetadata(
	requestType: 'PaymentRequest' | 'PurchaseRequest',
	requestIds: readonly string[],
	database: ReportMetadataReader,
	signal?: AbortSignal,
): Promise<Map<string, string | null>> {
	if (requestIds.length === 0) return new Map();
	assertQueryActive(signal);
	const rows = await database.$queryRaw<ReportMetadataRow[]>(metadataQuery(requestType, requestIds));
	assertQueryActive(signal);
	if (!Array.isArray(rows) || rows.some((row) => !isReportMetadataRow(row))) {
		throw createHttpError(500, 'Report metadata query returned an invalid result.');
	}
	if (rows.some((row) => row.isOversized)) {
		throw createHttpError(
			413,
			`Report request metadata exceeds ${REPORT_MAX_METADATA_BYTES_PER_REQUEST} bytes. Narrow the report filters.`,
		);
	}
	const metadataById = new Map(rows.map((row) => [row.id, row.metadata]));
	if (requestIds.some((id) => !metadataById.has(id))) {
		throw createHttpError(500, 'Report metadata snapshot is incomplete.');
	}
	return metadataById;
}
