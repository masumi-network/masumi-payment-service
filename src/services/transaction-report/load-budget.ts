import { normalizeAssetUnit } from '@/utils/asset-units';
import createHttpError from 'http-errors';
import type { ReportRequestRecord, ReportRow } from './records';

export type ReportLoadBudgetLimits = {
	maxEvents?: number;
	maxMetadataBytes?: number;
	maxAssetEntries?: number;
	maxAssetUnits?: number;
	maxSerializedBytes?: number;
};

const DEFAULT_MAX_EVENTS = 500_000;
const DEFAULT_MAX_METADATA_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ASSET_ENTRIES = 500_000;
const DEFAULT_MAX_ASSET_UNITS = 10_000;
const DEFAULT_MAX_SERIALIZED_BYTES = 64 * 1024 * 1024;

function stringBytes(value: string | null | undefined): number {
	return value == null ? 0 : Buffer.byteLength(value, 'utf8');
}

function recordAmounts(record: ReportRequestRecord) {
	return [...record.requestedFunds, ...record.withdrawnForBuyer, ...record.withdrawnForSeller];
}

function serializeBigInt(_key: string, item: unknown): unknown {
	return typeof item === 'bigint' ? item.toString() : item;
}

function serializedBytes(value: ReportRequestRecord | ReportRow): number {
	return Buffer.byteLength(JSON.stringify(value, serializeBigInt), 'utf8');
}

function reportLimitError(label: string, maximum: number): Error {
	return createHttpError(413, `Report exceeds ${maximum} ${label}. Narrow the report filters.`);
}

type RecordCost = {
	events: number;
	metadataBytes: number;
	assetEntries: number;
	assetUnits: string[];
	serializedBytes: number;
};

export function createReportLoadBudget(
	limits: ReportLoadBudgetLimits = {},
): (record: ReportRequestRecord, row?: ReportRow) => void {
	const maxEvents = limits.maxEvents ?? DEFAULT_MAX_EVENTS;
	const maxMetadataBytes = limits.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
	const maxAssetEntries = limits.maxAssetEntries ?? DEFAULT_MAX_ASSET_ENTRIES;
	const maxAssetUnits = limits.maxAssetUnits ?? DEFAULT_MAX_ASSET_UNITS;
	const maxSerializedBytes = limits.maxSerializedBytes ?? DEFAULT_MAX_SERIALIZED_BYTES;
	const costs = new Map<string, RecordCost>();
	const assetUnitCounts = new Map<string, number>();
	let eventCount = 0;
	let metadataBytes = 0;
	let assetEntryCount = 0;
	let totalSerializedBytes = 0;

	return (record, row) => {
		const key = `${record.requestType}:${record.id}`;
		const previous = costs.get(key);
		if (previous != null) {
			eventCount -= previous.events;
			metadataBytes -= previous.metadataBytes;
			assetEntryCount -= previous.assetEntries;
			totalSerializedBytes -= previous.serializedBytes;
			for (const unit of previous.assetUnits) {
				const count = assetUnitCounts.get(unit)! - 1;
				if (count === 0) assetUnitCounts.delete(unit);
				else assetUnitCounts.set(unit, count);
			}
		}
		const amounts = recordAmounts(record);
		const cost: RecordCost = {
			events: record.transactions.length,
			metadataBytes: stringBytes(record.metadata),
			assetEntries: amounts.length,
			assetUnits: Array.from(new Set(amounts.map((amount) => normalizeAssetUnit(amount.unit)))),
			serializedBytes: serializedBytes(record) + (row == null ? 0 : serializedBytes(row)),
		};
		costs.set(key, cost);
		eventCount += cost.events;
		metadataBytes += cost.metadataBytes;
		assetEntryCount += cost.assetEntries;
		totalSerializedBytes += cost.serializedBytes;
		for (const unit of cost.assetUnits) assetUnitCounts.set(unit, (assetUnitCounts.get(unit) ?? 0) + 1);

		if (eventCount > maxEvents) throw reportLimitError('transaction events', maxEvents);
		if (metadataBytes > maxMetadataBytes) throw reportLimitError('metadata bytes', maxMetadataBytes);
		if (assetEntryCount > maxAssetEntries) throw reportLimitError('asset entries', maxAssetEntries);
		if (assetUnitCounts.size > maxAssetUnits) throw reportLimitError('unique asset units', maxAssetUnits);
		if (totalSerializedBytes > maxSerializedBytes) {
			throw reportLimitError('serialized bytes', maxSerializedBytes);
		}
	};
}
