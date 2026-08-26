import { constants as bufferConstants } from 'node:buffer';
import type { ReportFilterInput } from '@/routes/api/reports/schemas';
import { atomicToDecimalString, getReportAssetMetadata } from '@/utils/asset-units';
import { normalizeAmounts, type AtomicAmount } from './amounts';
import type {
	ReportAggregate,
	ReportAggregateMetric,
	ReportAggregateResult,
	ReportBucket,
	RequestedReportBucket,
} from './aggregate';
import type { ReportRow, ReportWarning } from './records';

type CsvCell = Readonly<{ value: string; isUntrusted: boolean }>;
type AmountColumns = Readonly<{ ada: string; usdm: string; usdcx: string; otherAssets: string }>;

type NormalizedReportFilters = Readonly<{
	paymentSourceId: ReportFilterInput['paymentSourceId'];
	managedWalletIds: readonly string[] | null;
	externalAddresses: readonly string[];
	roles: ReadonlyArray<ReportFilterInput['roles'][number]>;
	states: ReadonlyArray<NonNullable<ReportFilterInput['states']>[number]>;
	from: Date;
	to: Date;
	dateBasis: ReportFilterInput['dateBasis'];
	revenueMode: ReportFilterInput['revenueMode'];
	timeZone: ReportFilterInput['timeZone'];
}>;

export type ReportCsvMetadata = Readonly<{
	generatedAt: Date;
	asOf: Date;
	paymentSource: Readonly<{
		id: string;
		network: string;
		paymentSourceType: ReportRow['paymentSourceType'];
		feeRatePermille: number;
		smartContractAddress: string;
		deletedAt: Date | null;
	}>;
	filters: NormalizedReportFilters;
	requestedBucket: RequestedReportBucket;
	bucket: ReportBucket;
	warnings?: readonly ReportWarning[];
}>;

export type ReportCsvOptions = Readonly<{ maxBytes?: number }>;

export const REPORT_CSV_MAX_BYTES = 64 * 1024 * 1024;

export class ReportCsvSizeLimitError extends Error {
	readonly statusCode = 413;

	constructor(readonly maxBytes: number) {
		super(`Report CSV exceeds ${maxBytes} bytes. Narrow the report filters.`);
		this.name = 'ReportCsvSizeLimitError';
	}
}

const AMOUNT_SUFFIXES = ['ada', 'usdm', 'usdcx', 'other_assets_json'] as const;
const AGGREGATE_METRICS = [
	'sellerGrossRevenue',
	'protocolFees',
	'sellerCardanoFees',
	'sellerNetRevenue',
	'buyerGrossSpend',
	'returnedFunds',
	'buyerCardanoFees',
	'buyerNetSpend',
	'actorCardanoFees',
	'adminCardanoFees',
	'totalCardanoFees',
] as const satisfies ReadonlyArray<Exclude<keyof ReportAggregate, 'transactionCount' | 'transactionCountCompleteness'>>;

const AGGREGATE_METRIC_NAMES: Record<(typeof AGGREGATE_METRICS)[number], string> = {
	sellerGrossRevenue: 'seller_gross_revenue',
	protocolFees: 'protocol_fees',
	sellerCardanoFees: 'seller_cardano_fees',
	sellerNetRevenue: 'seller_net_revenue',
	buyerGrossSpend: 'buyer_gross_spend',
	returnedFunds: 'returned_funds',
	buyerCardanoFees: 'buyer_cardano_fees',
	buyerNetSpend: 'buyer_net_spend',
	actorCardanoFees: 'actor_cardano_fees',
	adminCardanoFees: 'admin_cardano_fees',
	totalCardanoFees: 'total_cardano_fees',
};

const CONTEXT_HEADERS = [
	'generated_at',
	'as_of',
	'payment_source_id',
	'payment_source_network',
	'payment_source_type',
	'payment_source_fee_rate_permille',
	'payment_source_fee_rate_percent',
	'payment_source_smart_contract_address',
	'payment_source_deleted_at',
	'filter_managed_wallet_ids_json',
	'filter_external_addresses_json',
	'filter_roles_json',
	'filter_states_json',
	'filter_from',
	'filter_to',
	'filter_date_basis',
	'filter_revenue_mode',
	'filter_time_zone',
	'filter_bucket',
	'report_bucket',
	'warning_codes_json',
] as const;

function trusted(value: string | number | boolean | null | undefined): CsvCell {
	return { value: value == null ? '' : String(value), isUntrusted: false };
}

function untrusted(value: string | null | undefined): CsvCell {
	return { value: value ?? '', isUntrusted: true };
}

function dateCell(value: Date | null): CsvCell {
	return trusted(value?.toISOString());
}

function stableStringArrayJson(values: readonly string[] | null): string {
	return JSON.stringify(values == null ? null : [...new Set(values)].sort((left, right) => left.localeCompare(right)));
}

const CSV_RECORD_SEPARATOR = '\r\n';
const CSV_RECORD_SEPARATOR_BYTES = Buffer.byteLength(CSV_RECORD_SEPARATOR, 'utf8');
const CSV_DOUBLE_QUOTE_BYTE = 0x22;
const CSV_FORMULA_PREFIX_BYTE = 0x27;
const CSV_FIELD_SEPARATOR_BYTE = 0x2c;
const CSV_CARRIAGE_RETURN_BYTE = 0x0d;
const CSV_LINE_FEED_BYTE = 0x0a;

function needsSpreadsheetFormulaProtection(cell: CsvCell): boolean {
	return cell.isUntrusted && /^(?:[\t\r\n]|\s*[=+\-@])/u.test(cell.value);
}

function quoteCount(value: string): number {
	let count = 0;
	let index = value.indexOf('"');
	while (index >= 0) {
		count += 1;
		index = value.indexOf('"', index + 1);
	}
	return count;
}

function csvCellByteLength(cell: CsvCell): number {
	return (
		2 +
		Buffer.byteLength(cell.value, 'utf8') +
		quoteCount(cell.value) +
		(needsSpreadsheetFormulaProtection(cell) ? 1 : 0)
	);
}

function csvRowByteLength(row: readonly CsvCell[]): number {
	return (
		row.reduce((total, cell) => total + csvCellByteLength(cell), 0) +
		Math.max(0, row.length - 1) +
		CSV_RECORD_SEPARATOR_BYTES
	);
}

function writeCsvCell(output: Buffer, startOffset: number, cell: CsvCell): number {
	let offset = startOffset;
	output[offset] = CSV_DOUBLE_QUOTE_BYTE;
	offset += 1;
	if (needsSpreadsheetFormulaProtection(cell)) {
		output[offset] = CSV_FORMULA_PREFIX_BYTE;
		offset += 1;
	}
	let segmentStart = 0;
	let quoteIndex = cell.value.indexOf('"');
	while (quoteIndex >= 0) {
		offset += output.write(cell.value.slice(segmentStart, quoteIndex), offset, 'utf8');
		output[offset] = CSV_DOUBLE_QUOTE_BYTE;
		output[offset + 1] = CSV_DOUBLE_QUOTE_BYTE;
		offset += 2;
		segmentStart = quoteIndex + 1;
		quoteIndex = cell.value.indexOf('"', segmentStart);
	}
	offset += output.write(cell.value.slice(segmentStart), offset, 'utf8');
	output[offset] = CSV_DOUBLE_QUOTE_BYTE;
	return offset + 1;
}

function writeCsvRow(output: Buffer, startOffset: number, row: readonly CsvCell[]): number {
	let offset = startOffset;
	for (let index = 0; index < row.length; index += 1) {
		if (index > 0) {
			output[offset] = CSV_FIELD_SEPARATOR_BYTE;
			offset += 1;
		}
		offset = writeCsvCell(output, offset, row[index]);
	}
	output[offset] = CSV_CARRIAGE_RETURN_BYTE;
	output[offset + 1] = CSV_LINE_FEED_BYTE;
	return offset + CSV_RECORD_SEPARATOR_BYTES;
}

function* csvRows(headers: readonly string[], rows: () => Iterable<readonly CsvCell[]>): Iterable<readonly CsvCell[]> {
	yield headers.map(trusted);
	yield* rows();
}

function csvMaxBytes(options: ReportCsvOptions): number {
	const maxBytes = options.maxBytes ?? REPORT_CSV_MAX_BYTES;
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > bufferConstants.MAX_LENGTH) {
		throw new RangeError(`CSV maxBytes must be a positive integer no larger than ${bufferConstants.MAX_LENGTH}`);
	}
	return maxBytes;
}

function createCsv(
	headers: readonly string[],
	rows: () => Iterable<readonly CsvCell[]>,
	options: ReportCsvOptions,
): Buffer {
	const maxBytes = csvMaxBytes(options);
	let totalBytes = 0;
	for (const row of csvRows(headers, rows)) {
		if (row.length !== headers.length) throw new RangeError('CSV row does not match its header');
		const rowBytes = csvRowByteLength(row);
		if (rowBytes > maxBytes - totalBytes) throw new ReportCsvSizeLimitError(maxBytes);
		totalBytes += rowBytes;
	}

	const output = Buffer.allocUnsafe(totalBytes);
	let offset = 0;
	for (const row of csvRows(headers, rows)) offset = writeCsvRow(output, offset, row);
	if (offset !== totalBytes) throw new RangeError('CSV byte length changed during encoding');
	return output;
}

function splitAmounts(amounts: readonly AtomicAmount[] | null): AmountColumns | null {
	if (amounts == null) return null;
	const known = new Map<'ada' | 'usdm' | 'usdcx', bigint>();
	const other: Record<string, string> = {};
	for (const amount of normalizeAmounts(amounts)) {
		const metadata = getReportAssetMetadata(amount.unit);
		if (metadata == null) other[amount.unit] = amount.amount.toString();
		else known.set(metadata.key, (known.get(metadata.key) ?? 0n) + amount.amount);
	}
	return {
		ada: atomicToDecimalString(known.get('ada') ?? 0n, 6),
		usdm: atomicToDecimalString(known.get('usdm') ?? 0n, 6),
		usdcx: atomicToDecimalString(known.get('usdcx') ?? 0n, 6),
		otherAssets: JSON.stringify(other),
	};
}

function amountHeaders(prefix: string): string[] {
	return AMOUNT_SUFFIXES.map((suffix) => `${prefix}_${suffix}`);
}

function amountCells(amounts: readonly AtomicAmount[] | null): CsvCell[] {
	const columns = splitAmounts(amounts);
	return columns == null
		? [trusted(''), trusted(''), trusted(''), trusted('')]
		: [trusted(columns.ada), trusted(columns.usdm), trusted(columns.usdcx), trusted(columns.otherAssets)];
}

function aggregateMetricHeaders(prefix: string): string[] {
	return [...amountHeaders(prefix), `${prefix}_completeness`];
}

function aggregateMetricCells(metric: ReportAggregateMetric): CsvCell[] {
	return [...amountCells(metric.amounts), trusted(metric.completeness)];
}

function aggregateHeaders(): string[] {
	return [
		'transaction_count',
		'transaction_count_completeness',
		...AGGREGATE_METRICS.flatMap((metric) => aggregateMetricHeaders(AGGREGATE_METRIC_NAMES[metric])),
	];
}

function aggregateCells(aggregate: ReportAggregate): CsvCell[] {
	return [
		trusted(aggregate.transactionCount),
		trusted(aggregate.transactionCountCompleteness),
		...AGGREGATE_METRICS.flatMap((metric) => aggregateMetricCells(aggregate[metric])),
	];
}

function contextCells(metadata: ReportCsvMetadata): CsvCell[] {
	const filters = metadata.filters;
	const warningCodes = [...new Set((metadata.warnings ?? []).map((warning) => warning.code))].sort((left, right) =>
		left.localeCompare(right),
	);
	return [
		dateCell(metadata.generatedAt),
		dateCell(metadata.asOf),
		untrusted(metadata.paymentSource.id),
		trusted(metadata.paymentSource.network),
		trusted(metadata.paymentSource.paymentSourceType),
		trusted(metadata.paymentSource.feeRatePermille),
		trusted(atomicToDecimalString(BigInt(metadata.paymentSource.feeRatePermille), 1)),
		untrusted(metadata.paymentSource.smartContractAddress),
		dateCell(metadata.paymentSource.deletedAt),
		trusted(stableStringArrayJson(filters.managedWalletIds)),
		trusted(stableStringArrayJson(filters.externalAddresses)),
		trusted(stableStringArrayJson(filters.roles)),
		trusted(stableStringArrayJson(filters.states)),
		dateCell(filters.from),
		dateCell(filters.to),
		trusted(filters.dateBasis),
		trusted(filters.revenueMode),
		untrusted(filters.timeZone),
		trusted(metadata.requestedBucket),
		trusted(metadata.bucket),
		trusted(JSON.stringify(warningCodes)),
	];
}

function rowAmountGroups(row: ReportRow): ReadonlyArray<readonly AtomicAmount[] | null> {
	return [
		row.seller?.grossRevenue ?? null,
		row.seller?.protocolFee.amounts ?? null,
		row.seller?.cardanoFees ?? null,
		row.seller?.netRevenue ?? null,
		row.buyer?.grossSpend ?? null,
		row.buyer?.returnedFunds ?? null,
		row.buyer?.cardanoFees ?? null,
		row.buyer?.netSpend ?? null,
	];
}

const TRANSACTION_AMOUNT_PREFIXES = [
	'seller_gross_revenue',
	'protocol_fee',
	'seller_cardano_fees',
	'seller_net_revenue',
	'buyer_gross_spend',
	'buyer_returned_funds',
	'buyer_cardano_fees',
	'buyer_net_spend',
] as const;

const TRANSACTION_HEADERS = [
	'id',
	'blockchain_identifier',
	'role',
	'request_type',
	'on_chain_state',
	'created_at',
	'funds_locked_at',
	'seller_revenue_recognized_at',
	'buyer_gross_spend_at',
	'buyer_returned_at',
	'managed_wallet_id',
	'managed_wallet_address',
	'managed_wallet_vkey',
	'managed_wallet_collection_address',
	'managed_wallet_deleted_at',
	'agent_identifier',
	'agent_name',
	'counterparty_address',
	'buyer_return_address',
	'seller_return_address',
	'metadata',
	...TRANSACTION_AMOUNT_PREFIXES.flatMap(amountHeaders),
	'protocol_fee_configured_rate_permille',
	'protocol_fee_configured_rate_percent',
	'protocol_fee_applied_rate_permille',
	'protocol_fee_applied_rate_percent',
	'protocol_fee_provenance',
	'protocol_fee_basis',
	'protocol_fee_completeness',
	'seller_payout_completeness',
	'buyer_payout_completeness',
	'seller_cardano_fee_timing',
	'buyer_cardano_fee_timing',
	'actor_cardano_fee_allocation_strategy',
	'actor_cardano_fee_allocation_completeness',
	'actor_cardano_fee_allocation_attached_at',
	'fee_allocation_scope',
	'fee_component_scope',
	'reconciliation_buyer_cardano_fee_ada',
	'reconciliation_seller_cardano_fee_ada',
	'reconciliation_admin_cardano_fee_ada',
	'reconciliation_total_cardano_fee_ada',
	'reconciliation_completeness',
	'reconciliation_is_aggregation_owner',
] as const;

function optionalPermillePercent(value: number | null): CsvCell {
	return value == null ? trusted('') : trusted(atomicToDecimalString(BigInt(value), 1));
}

function optionalAda(value: bigint | null): CsvCell {
	return value == null ? trusted('') : trusted(atomicToDecimalString(value, 6));
}

function transactionCells(row: ReportRow): CsvCell[] {
	const protocolFee = row.seller?.protocolFee;
	return [
		untrusted(row.id),
		untrusted(row.blockchainIdentifier),
		trusted(row.role),
		trusted(row.requestType),
		trusted(row.onChainState),
		dateCell(row.createdAt),
		dateCell(row.timestamps.fundsLockedAt),
		dateCell(row.timestamps.sellerRevenueRecognizedAt),
		dateCell(row.timestamps.buyerGrossSpendAt),
		dateCell(row.timestamps.buyerReturnedAt),
		untrusted(row.managedWallet?.id),
		untrusted(row.managedWallet?.walletAddress),
		untrusted(row.managedWallet?.walletVkey),
		untrusted(row.managedWallet?.collectionAddress),
		dateCell(row.managedWallet?.deletedAt ?? null),
		untrusted(row.agentIdentifier),
		untrusted(row.agentName),
		untrusted(row.counterpartyAddress),
		untrusted(row.buyerReturnAddress),
		untrusted(row.sellerReturnAddress),
		untrusted(row.metadata),
		...rowAmountGroups(row).flatMap(amountCells),
		trusted(protocolFee?.configuredRatePermille),
		optionalPermillePercent(protocolFee?.configuredRatePermille ?? null),
		trusted(protocolFee?.appliedRatePermille),
		optionalPermillePercent(protocolFee?.appliedRatePermille ?? null),
		trusted(protocolFee?.provenance),
		trusted(protocolFee?.basis),
		trusted(protocolFee?.completeness),
		trusted(row.seller == null ? '' : row.sellerPayoutCompleteness),
		trusted(row.buyer == null ? '' : row.buyerPayoutCompleteness),
		trusted(row.seller?.cardanoFeeTiming),
		trusted(row.buyer?.cardanoFeeTiming),
		trusted(row.actorCardanoFeeAllocation.strategy),
		trusted(row.actorCardanoFeeAllocation.completeness),
		dateCell(row.actorCardanoFeeAllocation.attachedAt),
		trusted(row.feeAllocationScope),
		trusted(row.feeComponentScope),
		optionalAda(row.cardanoFeeReconciliation.buyerCardanoFees),
		optionalAda(row.cardanoFeeReconciliation.sellerCardanoFees),
		optionalAda(row.cardanoFeeReconciliation.adminCardanoFees),
		optionalAda(row.cardanoFeeReconciliation.totalCardanoFees),
		trusted(row.cardanoFeeReconciliation.completeness),
		trusted(row.isFeeReconciliationOwner),
	];
}

/**
 * The file stays rectangular and standalone. One report_context row holds the filters and snapshot. Transaction rows
 * leave those context cells blank, which keeps large exports bounded without losing audit data.
 */
export function createTransactionsCsv(
	rows: readonly ReportRow[],
	metadata: ReportCsvMetadata,
	options: ReportCsvOptions = {},
): Buffer {
	const headers = [...CONTEXT_HEADERS, 'record_type', ...TRANSACTION_HEADERS];
	const blankContextCells = CONTEXT_HEADERS.map(() => trusted(''));
	function* outputRows(): Iterable<readonly CsvCell[]> {
		yield [...contextCells(metadata), trusted('report_context'), ...TRANSACTION_HEADERS.map(() => trusted(''))];
		for (const row of rows) {
			yield [...blankContextCells, trusted('transaction'), ...transactionCells(row)];
		}
	}
	return createCsv(headers, outputRows, options);
}

export function createWalletSummaryCsv(
	result: ReportAggregateResult,
	metadata: ReportCsvMetadata,
	options: ReportCsvOptions = {},
): Buffer {
	const aggregateColumnHeaders = aggregateHeaders();
	const walletColumnHeaders = [
		'managed_wallet_id',
		'managed_wallet_address',
		'managed_wallet_vkey',
		'managed_wallet_collection_address',
		'managed_wallet_deleted_at',
		'role',
	] as const;
	const headers = [
		...CONTEXT_HEADERS,
		'record_type',
		'history_fee_completeness',
		...walletColumnHeaders,
		...aggregateColumnHeaders,
	];
	const wallets = [...result.wallets].sort((left, right) => {
		const walletComparison = (left.managedWallet?.id ?? '').localeCompare(right.managedWallet?.id ?? '');
		return walletComparison || left.role.localeCompare(right.role);
	});
	const blankContextCells = CONTEXT_HEADERS.map(() => trusted(''));
	function* outputRows(): Iterable<readonly CsvCell[]> {
		yield [
			...contextCells(metadata),
			trusted('report_context'),
			trusted(result.historyFeeCompleteness),
			...walletColumnHeaders.map(() => trusted('')),
			...aggregateColumnHeaders.map(() => trusted('')),
		];
		for (const wallet of wallets) {
			yield [
				...blankContextCells,
				trusted('wallet_summary'),
				trusted(''),
				untrusted(wallet.managedWallet?.id),
				untrusted(wallet.managedWallet?.walletAddress),
				untrusted(wallet.managedWallet?.walletVkey),
				untrusted(wallet.managedWallet?.collectionAddress),
				dateCell(wallet.managedWallet?.deletedAt ?? null),
				trusted(wallet.role),
				...aggregateCells(wallet.metrics),
			];
		}
	}
	return createCsv(headers, outputRows, options);
}

export function createTotalsCsv(
	result: ReportAggregateResult,
	metadata: ReportCsvMetadata,
	options: ReportCsvOptions = {},
): Buffer {
	const headers = [...CONTEXT_HEADERS, 'history_fee_completeness', ...aggregateHeaders()];
	const row = [...contextCells(metadata), trusted(result.historyFeeCompleteness), ...aggregateCells(result.totals)];
	function* outputRows(): Iterable<readonly CsvCell[]> {
		yield row;
	}
	return createCsv(headers, outputRows, options);
}
