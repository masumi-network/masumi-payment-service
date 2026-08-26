import { OnChainState, Prisma, TransactionStatus } from '@/generated/prisma/client';
import { prisma } from '@masumi/payment-core/db';
import createHttpError from 'http-errors';
import type { ReportPaymentSourceType, RevenueMode } from './metrics';
import { getReportPayoutCompleteness } from './query-payouts';
import { loadReportMetadata } from './query-metadata';
import {
	assertBoundedRequestRelations,
	REPORT_MAX_FUND_ROWS_PER_REQUEST,
	REPORT_MAX_TRANSACTION_HISTORY_PER_REQUEST,
} from './query-bounds';
import type { ReportRequestRecord, ReportRole } from './records';
import type { ReportCursorPositions, ReportRoleCursor } from './query-cursor';
import { createReportLoadBudget, type ReportLoadBudgetLimits } from './load-budget';
import {
	attachedReportTransactionSelect,
	enrichReportTransactionEvidence,
	mapAttachedReportTransaction,
	reportFeeAllocationScope,
	reportFeeComponentScope,
} from './query-transactions';

export type ReportDateBasis = 'CreatedAt' | 'FundsLockedAt' | 'RevenueRecognizedAt';
export type ReportStateFilter = OnChainState | 'Pending';

export type ReportQueryFilters = {
	paymentSourceId: string;
	paymentSourceType: ReportPaymentSourceType;
	configuredFeeRatePermille: number;
	authorizedManagedWalletIds: string[] | null;
	externalAddresses: string[];
	roles: ReportRole[];
	states: ReportStateFilter[];
	from: Date;
	to: Date;
	dateBasis: ReportDateBasis;
	revenueMode: RevenueMode;
	asOf: Date;
};
export type ReportQueryClient = Pick<
	Prisma.TransactionClient,
	'paymentRequest' | 'purchaseRequest' | 'transaction' | '$queryRaw'
>;
export {
	createReportCursorSnapshot,
	createReportFilterFingerprint,
	decodeReportCursor,
	encodeReportCursor,
} from './query-cursor';
export type {
	DecodedReportCursor,
	ReportCursorPositions,
	ReportCursorSnapshot,
	ReportFilterFingerprintInput,
	ReportRoleCursor,
} from './query-cursor';

// Every on-chain state, deliberately. A request with no usable `FundsLocked`
// transition is admitted so the report can mark it undateable rather than drop
// it: such a row carries a null `fundsLockedAt`, so `getEventBucket` in
// `aggregate.ts` puts it in no history bucket and the affected metrics turn
// partial under HISTORY_ECONOMIC_TIMESTAMP_MISSING. Narrowing this list, or
// adding a date predicate here, would remove that signal.
const ALL_ON_CHAIN_STATES = Object.values(OnChainState);
const REPORT_FEE_CONTEXT_MAX_ROWS = 5_000;
const REPORT_FEE_CONTEXT_MAX_EVENTS = 100_000;
const REPORT_FEE_CONTEXT_MAX_QUERY_ROWS = 250;
const REPORT_FEE_CONTEXT_PAYMENT_KEY_BATCH_SIZE = 100;
const REPORT_FEE_CONTEXT_MAX_PAYMENT_KEYS = 10_000;
const REPORT_FEE_CONTEXT_MAX_SERIALIZED_BYTES = 32 * 1024 * 1024;
const REPORT_FEE_CONTEXT_MAX_METADATA_BYTES = 8 * 1024 * 1024;

const paymentReportSelect = {
	id: true,
	createdAt: true,
	blockchainIdentifier: true,
	agentIdentifier: true,
	agentName: true,
	onChainState: true,
	unlockTime: true,
	collateralReturnLovelace: true,
	buyerReturnAddress: true,
	sellerReturnAddress: true,
	totalBuyerCardanoFees: true,
	totalSellerCardanoFees: true,
	BuyerWallet: { select: { walletAddress: true, walletVkey: true } },
	SmartContractWallet: {
		select: { id: true, walletAddress: true, walletVkey: true, collectionAddress: true, deletedAt: true },
	},
	RequestedFunds: { take: REPORT_MAX_FUND_ROWS_PER_REQUEST + 1, select: { unit: true, amount: true } },
	WithdrawnForBuyer: { take: REPORT_MAX_FUND_ROWS_PER_REQUEST + 1, select: { unit: true, amount: true } },
	WithdrawnForSeller: { take: REPORT_MAX_FUND_ROWS_PER_REQUEST + 1, select: { unit: true, amount: true } },
	CurrentTransaction: { select: attachedReportTransactionSelect },
	TransactionHistory: {
		take: REPORT_MAX_TRANSACTION_HISTORY_PER_REQUEST + 1,
		select: attachedReportTransactionSelect,
	},
} satisfies Prisma.PaymentRequestSelect;

const purchaseReportSelect = {
	id: true,
	createdAt: true,
	blockchainIdentifier: true,
	agentIdentifier: true,
	agentName: true,
	onChainState: true,
	unlockTime: true,
	collateralReturnLovelace: true,
	buyerReturnAddress: true,
	sellerReturnAddress: true,
	totalBuyerCardanoFees: true,
	totalSellerCardanoFees: true,
	SellerWallet: { select: { walletAddress: true, walletVkey: true } },
	SmartContractWallet: {
		select: { id: true, walletAddress: true, walletVkey: true, collectionAddress: true, deletedAt: true },
	},
	PaidFunds: { take: REPORT_MAX_FUND_ROWS_PER_REQUEST + 1, select: { unit: true, amount: true } },
	WithdrawnForBuyer: { take: REPORT_MAX_FUND_ROWS_PER_REQUEST + 1, select: { unit: true, amount: true } },
	WithdrawnForSeller: { take: REPORT_MAX_FUND_ROWS_PER_REQUEST + 1, select: { unit: true, amount: true } },
	CurrentTransaction: { select: attachedReportTransactionSelect },
	TransactionHistory: {
		take: REPORT_MAX_TRANSACTION_HISTORY_PER_REQUEST + 1,
		select: attachedReportTransactionSelect,
	},
} satisfies Prisma.PurchaseRequestSelect;

type PaymentReportRecord = Prisma.PaymentRequestGetPayload<{ select: typeof paymentReportSelect }>;
type PurchaseReportRecord = Prisma.PurchaseRequestGetPayload<{ select: typeof purchaseReportSelect }>;

function sortedUnique(values: readonly string[]): string[] {
	return Array.from(new Set(values)).sort();
}

function blockTimeRange(from: Date, to: Date) {
	return {
		gte: Math.ceil(from.getTime() / 1000),
		lt: Math.ceil(to.getTime() / 1000),
	};
}

function transactionTransitionFilter(state: OnChainState, from: Date, to: Date): Prisma.TransactionWhereInput {
	return {
		status: TransactionStatus.Confirmed,
		newOnChainState: state,
		blockTime: blockTimeRange(from, to),
	};
}

function transactionRelationWhere(transaction: Prisma.TransactionWhereInput) {
	return { OR: [{ CurrentTransaction: { is: transaction } }, { TransactionHistory: { some: transaction } }] };
}

function missingUsableTransitionWhere(state: OnChainState) {
	return {
		NOT: transactionRelationWhere({
			status: TransactionStatus.Confirmed,
			txHash: { not: null },
			newOnChainState: state,
			blockTime: { not: null },
		}),
	};
}

function paymentTransitionWhere(state: OnChainState, from: Date, to: Date): Prisma.PaymentRequestWhereInput {
	const transaction = transactionTransitionFilter(state, from, to);
	return transactionRelationWhere(transaction);
}

function purchaseTransitionWhere(state: OnChainState, from: Date, to: Date): Prisma.PurchaseRequestWhereInput {
	const transaction = transactionTransitionFilter(state, from, to);
	return transactionRelationWhere(transaction);
}

function feeEventWhere(from: Date, to: Date) {
	return {
		OR: [
			transactionRelationWhere({ status: TransactionStatus.Confirmed, blockTime: blockTimeRange(from, to) }),
			transactionRelationWhere({ status: TransactionStatus.Confirmed, blockTime: null }),
		],
	};
}

function sellerDateWhere(filters: ReportQueryFilters): Prisma.PaymentRequestWhereInput {
	if (filters.dateBasis === 'CreatedAt') return { createdAt: { gte: filters.from, lt: filters.to } };
	if (filters.dateBasis === 'FundsLockedAt') {
		return {
			OR: [
				paymentTransitionWhere(OnChainState.FundsLocked, filters.from, filters.to),
				{
					AND: [{ onChainState: { in: ALL_ON_CHAIN_STATES } }, missingUsableTransitionWhere(OnChainState.FundsLocked)],
				},
			],
		};
	}
	const feeEvent = feeEventWhere(filters.from, filters.to);
	if (filters.revenueMode === 'RequestedGross') {
		return { OR: [{ createdAt: { gte: filters.from, lt: filters.to } }, feeEvent] };
	}

	const settledStates = [OnChainState.Withdrawn, OnChainState.DisputedWithdrawn] as const;
	const settled = settledStates.map((state) => ({
		AND: [
			{ onChainState: state },
			{
				OR: [paymentTransitionWhere(state, filters.from, filters.to), missingUsableTransitionWhere(state)],
			},
		],
	}));
	if (filters.revenueMode === 'CashReceived') return { OR: [...settled, feeEvent] };
	return {
		OR: [
			...settled,
			feeEvent,
			{
				onChainState: { in: [OnChainState.ResultSubmitted, OnChainState.Withdrawn] },
				unlockTime: {
					gte: BigInt(filters.from.getTime()),
					lt: BigInt(filters.to.getTime()),
					lte: BigInt(filters.asOf.getTime()),
				},
			},
		],
	};
}

function buyerDateWhere(filters: ReportQueryFilters): Prisma.PurchaseRequestWhereInput {
	if (filters.dateBasis === 'CreatedAt') return { createdAt: { gte: filters.from, lt: filters.to } };
	if (filters.dateBasis === 'FundsLockedAt') {
		return {
			OR: [
				purchaseTransitionWhere(OnChainState.FundsLocked, filters.from, filters.to),
				{
					AND: [{ onChainState: { in: ALL_ON_CHAIN_STATES } }, missingUsableTransitionWhere(OnChainState.FundsLocked)],
				},
			],
		};
	}
	return {
		OR: [
			purchaseTransitionWhere(OnChainState.FundsLocked, filters.from, filters.to),
			{
				AND: [{ onChainState: { in: ALL_ON_CHAIN_STATES } }, missingUsableTransitionWhere(OnChainState.FundsLocked)],
			},
			purchaseTransitionWhere(OnChainState.RefundWithdrawn, filters.from, filters.to),
			{
				AND: [
					{ onChainState: OnChainState.RefundWithdrawn },
					missingUsableTransitionWhere(OnChainState.RefundWithdrawn),
				],
			},
			purchaseTransitionWhere(OnChainState.DisputedWithdrawn, filters.from, filters.to),
			{
				AND: [
					{ onChainState: OnChainState.DisputedWithdrawn },
					missingUsableTransitionWhere(OnChainState.DisputedWithdrawn),
				],
			},
			feeEventWhere(filters.from, filters.to),
		],
	};
}

function cursorWhere(cursor: ReportRoleCursor | null) {
	if (cursor == null) return {};
	return {
		OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }],
	};
}

function snapshotBoundaryWhere(asOf: Date) {
	// This is a monotonic boundary, not historical reconstruction. Requests whose
	// next action, state, or result changed after the snapshot are excluded instead of rewound.
	return {
		createdAt: { lte: asOf },
		nextActionOrOnChainStateOrResultLastChangedAt: { lte: asOf },
	};
}

function managedWalletWhere(authorizedManagedWalletIds: string[] | null) {
	return authorizedManagedWalletIds == null ? {} : { smartContractWalletId: { in: authorizedManagedWalletIds } };
}

function requestStateWhere(states: readonly ReportStateFilter[]) {
	if (states.length === 0) return {};
	const onChainStates = states.filter((state): state is OnChainState => state !== 'Pending');
	if (!states.includes('Pending')) return { onChainState: { in: onChainStates } };
	if (onChainStates.length === 0) return { onChainState: null };
	return { OR: [{ onChainState: { in: onChainStates } }, { onChainState: null }] };
}

function paymentExternalAddressWhere(externalAddresses: string[]): Prisma.PaymentRequestWhereInput {
	if (externalAddresses.length === 0) return {};
	return {
		OR: [
			{ buyerReturnAddress: { in: externalAddresses } },
			{ sellerReturnAddress: { in: externalAddresses } },
			{ BuyerWallet: { is: { walletAddress: { in: externalAddresses } } } },
			{ SmartContractWallet: { is: { collectionAddress: { in: externalAddresses } } } },
			{ SmartContractWallet: { is: { walletAddress: { in: externalAddresses } } } },
		],
	};
}

function purchaseExternalAddressWhere(externalAddresses: string[]): Prisma.PurchaseRequestWhereInput {
	if (externalAddresses.length === 0) return {};
	return {
		OR: [
			{ buyerReturnAddress: { in: externalAddresses } },
			{ sellerReturnAddress: { in: externalAddresses } },
			{ SellerWallet: { is: { walletAddress: { in: externalAddresses } } } },
			{ SmartContractWallet: { is: { collectionAddress: { in: externalAddresses } } } },
			{ SmartContractWallet: { is: { walletAddress: { in: externalAddresses } } } },
		],
	};
}

// The cursor belongs inside AND, never spread beside the other clauses.
// requestStateWhere returns a top-level OR for a mixed Pending plus on-chain
// filter and cursorWhere returns one too, so spreading both put two OR keys in
// one object literal: the cursor won and every page after the first ignored the
// state filter.
function buyerScopeWhere(
	filters: ReportQueryFilters,
	cursor: ReportRoleCursor | null = null,
): Prisma.PurchaseRequestWhereInput {
	return {
		paymentSourceId: filters.paymentSourceId,
		...managedWalletWhere(filters.authorizedManagedWalletIds),
		...requestStateWhere(filters.states),
		AND: [
			buyerDateWhere(filters),
			purchaseExternalAddressWhere(filters.externalAddresses),
			snapshotBoundaryWhere(filters.asOf),
			cursorWhere(cursor),
		],
	};
}

// See buyerScopeWhere: the cursor has to stay inside AND.
function sellerScopeWhere(
	filters: ReportQueryFilters,
	cursor: ReportRoleCursor | null = null,
): Prisma.PaymentRequestWhereInput {
	return {
		paymentSourceId: filters.paymentSourceId,
		...managedWalletWhere(filters.authorizedManagedWalletIds),
		...requestStateWhere(filters.states),
		AND: [
			sellerDateWhere(filters),
			paymentExternalAddressWhere(filters.externalAddresses),
			snapshotBoundaryWhere(filters.asOf),
			cursorWhere(cursor),
		],
	};
}

function paymentToReportRecord(
	record: PaymentReportRecord,
	metadata: string | null,
	filters: ReportQueryFilters,
): ReportRequestRecord {
	assertBoundedRequestRelations(
		record.TransactionHistory,
		record.RequestedFunds,
		record.WithdrawnForBuyer,
		record.WithdrawnForSeller,
	);
	const sourceTransactions = [record.CurrentTransaction, ...record.TransactionHistory];
	const transactions = sourceTransactions
		.map(mapAttachedReportTransaction)
		.filter((value): value is NonNullable<typeof value> => value != null)
		.map((value) => ({ ...value, relatedPaymentKeysComplete: false }));
	return {
		id: record.id,
		role: 'Seller',
		requestType: 'PaymentRequest',
		createdAt: record.createdAt,
		blockchainIdentifier: record.blockchainIdentifier,
		agentIdentifier: record.agentIdentifier,
		agentName: record.agentName,
		onChainState: record.onChainState,
		metadata,
		managedWallet: record.SmartContractWallet,
		counterpartyAddress: record.BuyerWallet?.walletAddress ?? null,
		buyerReturnAddress: record.buyerReturnAddress,
		sellerReturnAddress: record.sellerReturnAddress,
		paymentSourceType: filters.paymentSourceType,
		configuredFeeRatePermille: filters.configuredFeeRatePermille,
		unlockTime: record.unlockTime,
		collateralReturnLovelace: record.collateralReturnLovelace,
		requestedFunds: record.RequestedFunds,
		withdrawnForBuyer: record.WithdrawnForBuyer,
		withdrawnForSeller: record.WithdrawnForSeller,
		buyerPayoutCompleteness: getReportPayoutCompleteness({
			paymentSourceType: filters.paymentSourceType,
			onChainState: record.onChainState,
			returnAddress: record.buyerReturnAddress,
			expectedWalletVkey: record.BuyerWallet?.walletVkey ?? null,
			buyerCollateralReturnLovelace: record.collateralReturnLovelace,
			hasStoredPayoutEvidence: record.WithdrawnForBuyer.length > 0,
		}),
		sellerPayoutCompleteness: getReportPayoutCompleteness({
			paymentSourceType: filters.paymentSourceType,
			onChainState: record.onChainState,
			returnAddress: record.sellerReturnAddress,
			expectedWalletVkey: record.SmartContractWallet?.walletVkey ?? null,
			hasStoredPayoutEvidence: record.WithdrawnForSeller.length > 0,
		}),
		buyerCardanoFees: record.totalBuyerCardanoFees,
		sellerCardanoFees: record.totalSellerCardanoFees,
		transactions,
		feeAllocationScope: reportFeeAllocationScope(transactions),
		isFeeReconciliationOwner: true,
		feeComponentScope: reportFeeComponentScope(transactions, record.blockchainIdentifier),
	};
}

function purchaseToReportRecord(
	record: PurchaseReportRecord,
	metadata: string | null,
	filters: ReportQueryFilters,
): ReportRequestRecord {
	assertBoundedRequestRelations(
		record.TransactionHistory,
		record.PaidFunds,
		record.WithdrawnForBuyer,
		record.WithdrawnForSeller,
	);
	const sourceTransactions = [record.CurrentTransaction, ...record.TransactionHistory];
	const transactions = sourceTransactions
		.map(mapAttachedReportTransaction)
		.filter((value): value is NonNullable<typeof value> => value != null)
		.map((value) => ({ ...value, relatedPaymentKeysComplete: false }));
	return {
		id: record.id,
		role: 'Buyer',
		requestType: 'PurchaseRequest',
		createdAt: record.createdAt,
		blockchainIdentifier: record.blockchainIdentifier,
		agentIdentifier: record.agentIdentifier,
		agentName: record.agentName,
		onChainState: record.onChainState,
		metadata,
		managedWallet: record.SmartContractWallet,
		counterpartyAddress: record.SellerWallet.walletAddress,
		buyerReturnAddress: record.buyerReturnAddress,
		sellerReturnAddress: record.sellerReturnAddress,
		paymentSourceType: filters.paymentSourceType,
		configuredFeeRatePermille: filters.configuredFeeRatePermille,
		unlockTime: record.unlockTime,
		collateralReturnLovelace: record.collateralReturnLovelace,
		requestedFunds: record.PaidFunds,
		withdrawnForBuyer: record.WithdrawnForBuyer,
		withdrawnForSeller: record.WithdrawnForSeller,
		buyerPayoutCompleteness: getReportPayoutCompleteness({
			paymentSourceType: filters.paymentSourceType,
			onChainState: record.onChainState,
			returnAddress: record.buyerReturnAddress,
			expectedWalletVkey: record.SmartContractWallet?.walletVkey ?? null,
			buyerCollateralReturnLovelace: record.collateralReturnLovelace,
			hasStoredPayoutEvidence: record.WithdrawnForBuyer.length > 0,
		}),
		sellerPayoutCompleteness: getReportPayoutCompleteness({
			paymentSourceType: filters.paymentSourceType,
			onChainState: record.onChainState,
			returnAddress: record.sellerReturnAddress,
			expectedWalletVkey: record.SellerWallet.walletVkey,
			hasStoredPayoutEvidence: record.WithdrawnForSeller.length > 0,
		}),
		buyerCardanoFees: record.totalBuyerCardanoFees,
		sellerCardanoFees: record.totalSellerCardanoFees,
		transactions,
		feeAllocationScope: reportFeeAllocationScope(transactions),
		isFeeReconciliationOwner: true,
		feeComponentScope: reportFeeComponentScope(transactions, record.blockchainIdentifier),
	};
}

async function findSellerRecords(
	filters: ReportQueryFilters,
	cursor: ReportRoleCursor | null,
	take: number,
	database: ReportQueryClient,
	signal?: AbortSignal,
) {
	if (!filters.roles.includes('Seller')) return [];
	assertQueryActive(signal);
	const result = await database.paymentRequest.findMany({
		where: sellerScopeWhere(filters, cursor),
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		take,
		select: paymentReportSelect,
	});
	assertQueryActive(signal);
	const metadataById = await loadReportMetadata(
		'PaymentRequest',
		result.map((record) => record.id),
		database,
		signal,
	);
	return result.map((record) => paymentToReportRecord(record, metadataById.get(record.id) ?? null, filters));
}

async function findFeeContextRecords(
	filters: ReportQueryFilters,
	paymentKeys: string[],
	maxQueryRows: number,
	database: ReportQueryClient,
	signal?: AbortSignal,
): Promise<ReportRequestRecord[]> {
	assertQueryActive(signal);
	const sellerRecords = filters.roles.includes('Seller')
		? await database.paymentRequest.findMany({
				where: { ...sellerScopeWhere(filters), blockchainIdentifier: { in: paymentKeys } },
				take: maxQueryRows + 1,
				select: paymentReportSelect,
			})
		: [];
	assertQueryActive(signal);
	if (sellerRecords.length > maxQueryRows) {
		throw createHttpError(413, `Report fee context query exceeds ${maxQueryRows} rows. Narrow the report filters.`);
	}
	const sellerMetadata = await loadReportMetadata(
		'PaymentRequest',
		sellerRecords.map((record) => record.id),
		database,
		signal,
	);
	const buyerRecords = filters.roles.includes('Buyer')
		? await database.purchaseRequest.findMany({
				where: { ...buyerScopeWhere(filters), blockchainIdentifier: { in: paymentKeys } },
				take: maxQueryRows + 1,
				select: purchaseReportSelect,
			})
		: [];
	assertQueryActive(signal);
	if (buyerRecords.length > maxQueryRows) {
		throw createHttpError(413, `Report fee context query exceeds ${maxQueryRows} rows. Narrow the report filters.`);
	}
	const buyerMetadata = await loadReportMetadata(
		'PurchaseRequest',
		buyerRecords.map((record) => record.id),
		database,
		signal,
	);
	return [
		...sellerRecords.map((record) => paymentToReportRecord(record, sellerMetadata.get(record.id) ?? null, filters)),
		...buyerRecords.map((record) => purchaseToReportRecord(record, buyerMetadata.get(record.id) ?? null, filters)),
	];
}

function reportRequestKey(record: ReportRequestRecord): string {
	return `${record.requestType}:${record.id}`;
}

function assertQueryActive(signal?: AbortSignal): void {
	if (signal?.aborted) throw createHttpError(504, 'Report calculation timed out. Narrow the report filters.');
}

export async function queryReportFeeComponentClosure(
	seedRecords: readonly ReportRequestRecord[],
	filters: ReportQueryFilters,
	database: ReportQueryClient = prisma,
	limits: ReportLoadBudgetLimits & {
		maxRows?: number;
		maxQueryRows?: number;
		maxPaymentKeys?: number;
		signal?: AbortSignal;
	} = {},
): Promise<ReportRequestRecord[]> {
	const maxRows = limits.maxRows ?? REPORT_FEE_CONTEXT_MAX_ROWS;
	const maxQueryRows = limits.maxQueryRows ?? REPORT_FEE_CONTEXT_MAX_QUERY_ROWS;
	const maxPaymentKeys = limits.maxPaymentKeys ?? REPORT_FEE_CONTEXT_MAX_PAYMENT_KEYS;
	const signal = limits.signal;
	const consumeBudget = createReportLoadBudget({
		...limits,
		maxEvents: limits.maxEvents ?? REPORT_FEE_CONTEXT_MAX_EVENTS,
		maxMetadataBytes: limits.maxMetadataBytes ?? REPORT_FEE_CONTEXT_MAX_METADATA_BYTES,
		maxSerializedBytes: limits.maxSerializedBytes ?? REPORT_FEE_CONTEXT_MAX_SERIALIZED_BYTES,
	});
	const records = new Map<string, ReportRequestRecord>();
	const pendingPaymentKeys = new Set<string>();
	const queriedPaymentKeys = new Set<string>();
	const addRelatedPaymentKeys = (batch: readonly ReportRequestRecord[]) => {
		for (const record of batch) {
			assertQueryActive(signal);
			const paymentKeys = [
				record.blockchainIdentifier,
				...record.transactions.flatMap((transaction) => transaction.relatedPaymentKeys ?? []),
			];
			for (const key of paymentKeys) {
				if (!queriedPaymentKeys.has(key)) pendingPaymentKeys.add(key);
				if (pendingPaymentKeys.size + queriedPaymentKeys.size > maxPaymentKeys) {
					throw createHttpError(
						413,
						`Report fee context exceeds ${maxPaymentKeys} payment keys. Narrow the report filters.`,
					);
				}
			}
		}
	};
	for (const record of seedRecords) {
		assertQueryActive(signal);
		consumeBudget(record);
		records.set(reportRequestKey(record), record);
	}
	if (records.size > maxRows) {
		throw createHttpError(413, `Report fee context exceeds ${maxRows} rows. Narrow the report filters.`);
	}
	addRelatedPaymentKeys(seedRecords);

	while (pendingPaymentKeys.size > 0) {
		assertQueryActive(signal);
		const paymentKeys = Array.from(pendingPaymentKeys).slice(0, REPORT_FEE_CONTEXT_PAYMENT_KEY_BATCH_SIZE);
		for (const key of paymentKeys) {
			pendingPaymentKeys.delete(key);
			queriedPaymentKeys.add(key);
		}
		const batch = await enrichReportTransactionEvidence(
			await findFeeContextRecords(filters, paymentKeys, maxQueryRows, database, signal),
			database,
			signal,
		);
		assertQueryActive(signal);
		for (const record of batch) {
			assertQueryActive(signal);
			const key = reportRequestKey(record);
			consumeBudget(record);
			records.set(key, record);
		}
		if (records.size > maxRows) {
			throw createHttpError(413, `Report fee context exceeds ${maxRows} rows. Narrow the report filters.`);
		}
		addRelatedPaymentKeys(batch);
	}

	const result = Array.from(records.values());
	const buyerPaymentKeys = new Set(
		result.filter((record) => record.role === 'Buyer').map((record) => record.blockchainIdentifier),
	);
	return result.map((record) =>
		record.role === 'Seller'
			? { ...record, isFeeReconciliationOwner: !buyerPaymentKeys.has(record.blockchainIdentifier) }
			: record,
	);
}

async function findBuyerRecords(
	filters: ReportQueryFilters,
	cursor: ReportRoleCursor | null,
	take: number,
	database: ReportQueryClient,
	signal?: AbortSignal,
) {
	if (!filters.roles.includes('Buyer')) return [];
	assertQueryActive(signal);
	const result = await database.purchaseRequest.findMany({
		where: buyerScopeWhere(filters, cursor),
		orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
		take,
		select: purchaseReportSelect,
	});
	assertQueryActive(signal);
	const metadataById = await loadReportMetadata(
		'PurchaseRequest',
		result.map((record) => record.id),
		database,
		signal,
	);
	return result.map((record) => purchaseToReportRecord(record, metadataById.get(record.id) ?? null, filters));
}

async function assignFeeReconciliationOwners(
	records: ReportRequestRecord[],
	filters: ReportQueryFilters,
	database: ReportQueryClient,
	signal?: AbortSignal,
): Promise<ReportRequestRecord[]> {
	const sellerPaymentKeys = sortedUnique(
		records.filter((record) => record.role === 'Seller').map((record) => record.blockchainIdentifier),
	);
	if (!filters.roles.includes('Buyer') || sellerPaymentKeys.length === 0) return records;
	assertQueryActive(signal);
	const buyers = await database.purchaseRequest.findMany({
		where: { ...buyerScopeWhere(filters), blockchainIdentifier: { in: sellerPaymentKeys } },
		select: { blockchainIdentifier: true },
	});
	assertQueryActive(signal);
	const buyerPaymentKeys = new Set(buyers.map((record) => record.blockchainIdentifier));
	return records.map((record) =>
		record.role === 'Seller'
			? { ...record, isFeeReconciliationOwner: !buyerPaymentKeys.has(record.blockchainIdentifier) }
			: record,
	);
}

function compareRecords(left: ReportRequestRecord, right: ReportRequestRecord): number {
	const dateDifference = right.createdAt.getTime() - left.createdAt.getTime();
	if (dateDifference !== 0) return dateDifference;
	if (left.role !== right.role) return left.role === 'Seller' ? -1 : 1;
	return right.id.localeCompare(left.id);
}

function nextRoleCursor(
	rows: readonly ReportRequestRecord[],
	role: ReportRole,
	previous: ReportRoleCursor | null,
): ReportRoleCursor | null {
	const roleRows = rows.filter((candidate) => candidate.role === role);
	const row = roleRows[roleRows.length - 1];
	return row == null ? previous : { createdAt: row.createdAt, id: row.id };
}

export async function queryReportPage(
	filters: ReportQueryFilters,
	cursor: ReportCursorPositions,
	limit: number,
	database: ReportQueryClient = prisma,
	signal?: AbortSignal,
): Promise<{ records: ReportRequestRecord[]; nextCursor: ReportCursorPositions | null }> {
	assertQueryActive(signal);
	const takePerRole = limit + 1;
	const [sellerRecords, buyerRecords] = await Promise.all([
		findSellerRecords(filters, cursor.Seller, takePerRole, database, signal),
		findBuyerRecords(filters, cursor.Buyer, takePerRole, database, signal),
	]);
	assertQueryActive(signal);
	const merged = [...sellerRecords, ...buyerRecords].sort(compareRecords);
	const enriched = await enrichReportTransactionEvidence(merged.slice(0, limit), database, signal);
	assertQueryActive(signal);
	const records = await assignFeeReconciliationOwners(enriched, filters, database, signal);
	assertQueryActive(signal);
	if (merged.length <= limit) return { records, nextCursor: null };
	return {
		records,
		nextCursor: {
			Seller: nextRoleCursor(records, 'Seller', cursor.Seller),
			Buyer: nextRoleCursor(records, 'Buyer', cursor.Buyer),
		},
	};
}
