import { HotWalletType, Network, OnChainState, PaymentSourceType } from '@/generated/prisma/client';
import { z } from '@masumi/payment-core/zod';

export const REPORT_MAX_RANGE_DAYS = 3_660;
export const REPORT_DEFAULT_PAGE_SIZE = 50;
export const REPORT_MAX_PAGE_SIZE = 100;

const reportRoleSchema = z.enum(['Buyer', 'Seller']);
export const reportStateFilterSchema = z.union([z.nativeEnum(OnChainState), z.literal('Pending')]);
const revenueModeSchema = z.enum(['Billable', 'CashReceived', 'RequestedGross']);
const dateBasisSchema = z.enum(['CreatedAt', 'FundsLockedAt', 'RevenueRecognizedAt']);
const bucketSchema = z.enum(['Auto', 'Day', 'Week', 'Month']);

const timeZoneSchema = z
	.string()
	.min(1)
	.max(100)
	.default('Etc/UTC')
	.refine((timeZone) => {
		try {
			new Intl.DateTimeFormat('en-US', { timeZone }).format();
			return true;
		} catch {
			return false;
		}
	}, 'Invalid IANA time zone');

export const REPORT_FIAT_CURRENCIES = ['usd', 'eur', 'gbp', 'jpy', 'chf', 'aed'] as const;
export const REPORT_FIAT_MODES = ['PeriodAverage', 'AccountingDate'] as const;

const suppliedFiatRateSchema = z.object({
	unit: z.string().max(200),
	rate: z
		.string()
		.regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, 'Fiat rate must be a positive decimal string')
		.refine((value) => value !== '0' && !/^0\.0+$/.test(value), 'Fiat rate must be greater than zero'),
	from: z.coerce.date().optional(),
	to: z.coerce.date().optional(),
});

export const reportFilterSchema = z
	.object({
		paymentSourceId: z.string().min(1).max(250),
		managedWalletIds: z.array(z.string().min(1).max(250)).max(100).optional(),
		externalAddresses: z.array(z.string().min(1).max(250)).max(100).optional(),
		roles: z.array(reportRoleSchema).min(1).max(2).default(['Buyer', 'Seller']),
		states: z.array(reportStateFilterSchema).max(11).optional(),
		from: z.coerce.date(),
		to: z.coerce.date(),
		dateBasis: dateBasisSchema.default('RevenueRecognizedAt'),
		revenueMode: revenueModeSchema.default('Billable'),
		timeZone: timeZoneSchema,
		fiat: z
			.object({
				currency: z.enum(REPORT_FIAT_CURRENCIES),
				mode: z.enum(REPORT_FIAT_MODES).default('PeriodAverage'),
				suppliedRates: z.array(suppliedFiatRateSchema).max(100).optional(),
			})
			.optional(),
	})
	.superRefine((input, ctx) => {
		if (input.to.getTime() <= input.from.getTime()) {
			ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must be after from' });
			return;
		}
		const rangeMilliseconds = input.to.getTime() - input.from.getTime();
		if (rangeMilliseconds > REPORT_MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
			ctx.addIssue({
				code: 'custom',
				path: ['to'],
				message: `Report range must not exceed ${REPORT_MAX_RANGE_DAYS} days`,
			});
		}
		for (const rate of input.fiat?.suppliedRates ?? []) {
			if (rate.from != null && rate.to != null && rate.to.getTime() <= rate.from.getTime()) {
				ctx.addIssue({ code: 'custom', path: ['fiat', 'suppliedRates'], message: 'Rate to must be after rate from' });
			}
		}
	});

export const reportTransactionsInputSchema = reportFilterSchema.and(
	z.object({
		cursor: z.string().max(4_000).optional(),
		limit: z.coerce.number().int().min(1).max(REPORT_MAX_PAGE_SIZE).default(REPORT_DEFAULT_PAGE_SIZE),
	}),
);

export const reportSummaryInputSchema = reportFilterSchema.and(z.object({ bucket: bucketSchema.default('Auto') }));

export const serializedReportAmountSchema = z.object({
	unit: z.string(),
	rawAmount: z.string().regex(/^-?\d+$/),
	decimalAmount: z.string().nullable(),
	decimals: z.number().int().min(0).nullable(),
	symbol: z.string().nullable(),
});

const reportProtocolFeeSchema = z.object({
	configuredRatePermille: z.number().int().min(0).max(1000),
	appliedRatePermille: z.number().int().min(0).max(1000).nullable(),
	amounts: z.array(serializedReportAmountSchema).nullable(),
	provenance: z.enum(['calculated', 'projected', 'exact_zero', 'not_applicable', 'insufficient_data']),
	basis: z.enum(['stored_requested_plus_collateral', 'contract_version']).nullable(),
	completeness: z.enum(['exact', 'reconstructed', 'not_applicable', 'insufficient_data']),
});

const reportSellerMetricsSchema = z.object({
	grossRevenue: z.array(serializedReportAmountSchema).nullable(),
	protocolFee: reportProtocolFeeSchema,
	cardanoFees: z.array(serializedReportAmountSchema),
	cardanoFeeTiming: z.enum(['stored_cumulative', 'accounting_allocation']),
	netRevenue: z.array(serializedReportAmountSchema).nullable(),
	payoutCompleteness: z.enum(['complete', 'partial']),
});

const reportBuyerMetricsSchema = z.object({
	grossSpend: z.array(serializedReportAmountSchema).nullable(),
	returnedFunds: z.array(serializedReportAmountSchema).nullable(),
	cardanoFees: z.array(serializedReportAmountSchema),
	cardanoFeeTiming: z.enum(['stored_cumulative', 'accounting_allocation']),
	netSpend: z.array(serializedReportAmountSchema).nullable(),
	payoutCompleteness: z.enum(['complete', 'partial']),
});

const reportManagedWalletSchema = z.object({
	id: z.string(),
	walletAddress: z.string(),
	walletVkey: z.string(),
	collectionAddress: z.string().nullable(),
	deletedAt: z.date().nullable(),
});

const cardanoFeeReconciliationSchema = z.object({
	buyerCardanoFees: serializedReportAmountSchema,
	sellerCardanoFees: serializedReportAmountSchema,
	adminCardanoFees: serializedReportAmountSchema.nullable(),
	totalCardanoFees: serializedReportAmountSchema.nullable(),
	completeness: z.enum(['complete', 'partial', 'inconsistent']),
	isAggregationOwner: z.boolean(),
});

export const reportTransactionRowSchema = z.object({
	id: z.string(),
	role: reportRoleSchema,
	requestType: z.enum(['PaymentRequest', 'PurchaseRequest']),
	createdAt: z.date(),
	blockchainIdentifier: z.string(),
	agentIdentifier: z.string().nullable(),
	agentName: z.string().nullable(),
	onChainState: z.nativeEnum(OnChainState).nullable(),
	metadata: z.string().nullable(),
	managedWallet: reportManagedWalletSchema.nullable(),
	counterpartyAddress: z.string().nullable(),
	buyerReturnAddress: z.string().nullable(),
	sellerReturnAddress: z.string().nullable(),
	timestamps: z.object({
		createdAt: z.date(),
		fundsLockedAt: z.date().nullable(),
		sellerRevenueRecognizedAt: z.date().nullable(),
		buyerGrossSpendAt: z.date().nullable(),
		buyerReturnedAt: z.date().nullable(),
	}),
	settlement: z.object({
		resultSubmittedTxHash: z.string().nullable(),
		settlementTxHash: z.string().nullable(),
		settlementTxType: z.enum(['Withdrawn', 'RefundWithdrawn', 'DisputedWithdrawn']).nullable(),
	}),
	seller: reportSellerMetricsSchema.nullable(),
	buyer: reportBuyerMetricsSchema.nullable(),
	actorCardanoFeeAllocation: z.object({
		strategy: z.enum(['accounting_allocation', 'lifetime_cohort']),
		completeness: z.enum(['complete', 'partial']),
		attachedAt: z.date().nullable(),
	}),
	feeAllocationScope: z.enum(['single_request', 'shared_or_unknown']),
	feeComponentScope: z.enum(['complete', 'partial']),
	cardanoFeeReconciliation: cardanoFeeReconciliationSchema,
});

export const reportWarningSchema = z.object({
	code: z.string(),
	message: z.string(),
	rowId: z.string().nullable(),
});

const reportPaymentSourceSchema = z.object({
	id: z.string(),
	network: z.nativeEnum(Network),
	paymentSourceType: z.nativeEnum(PaymentSourceType),
	feeRatePermille: z.number().int().min(0).max(1000),
	smartContractAddress: z.string(),
	deletedAt: z.date().nullable(),
});

const normalizedFiltersSchema = z.object({
	paymentSourceId: z.string(),
	managedWalletIds: z.array(z.string()).nullable(),
	externalAddresses: z.array(z.string()),
	roles: z.array(reportRoleSchema),
	states: z.array(reportStateFilterSchema),
	from: z.date(),
	to: z.date(),
	dateBasis: dateBasisSchema,
	revenueMode: revenueModeSchema,
	timeZone: z.string(),
});

const reportFiatMetadataSchema = z.object({
	currency: z.string(),
	mode: z.enum(['PeriodAverage', 'AccountingDate']),
	provider: z.enum(['coingecko', 'supplied']),
	attribution: z.string().nullable(),
	isDemoKey: z.boolean(),
	demoHistoryDays: z.number().int().nullable(),
	completeness: z.enum(['complete', 'partial']),
	unpricedUnits: z.array(z.string()),
	rates: z
		.array(z.object({ unit: z.string(), rate: z.string(), source: z.enum(['supplied', 'coingecko']) }))
		.nullable(),
});

const reportMetadataSchema = z.object({
	generatedAt: z.date(),
	asOf: z.date(),
	paymentSource: reportPaymentSourceSchema,
	filters: normalizedFiltersSchema,
	fiat: reportFiatMetadataSchema.nullable(),
	warnings: z.array(reportWarningSchema),
});

export const reportTransactionsOutputSchema = z.object({
	rows: z.array(reportTransactionRowSchema),
	page: z.object({
		nextCursor: z.string().nullable(),
		hasMore: z.boolean(),
	}),
	metadata: reportMetadataSchema,
});

const reportAggregateMetricSchema = z.object({
	amounts: z.array(serializedReportAmountSchema),
	completeness: z.enum(['complete', 'partial']),
});

const reportAggregateSchema = z.object({
	transactionCount: z.number().int().min(0),
	transactionCountCompleteness: z.enum(['complete', 'partial']),
	sellerGrossRevenue: reportAggregateMetricSchema,
	protocolFees: reportAggregateMetricSchema,
	sellerCardanoFees: reportAggregateMetricSchema,
	actorCardanoFees: reportAggregateMetricSchema,
	sellerNetRevenue: reportAggregateMetricSchema,
	buyerGrossSpend: reportAggregateMetricSchema,
	returnedFunds: reportAggregateMetricSchema,
	buyerCardanoFees: reportAggregateMetricSchema,
	buyerNetSpend: reportAggregateMetricSchema,
	adminCardanoFees: reportAggregateMetricSchema,
	totalCardanoFees: reportAggregateMetricSchema,
});

export const reportSummaryOutputSchema = z.object({
	totals: reportAggregateSchema,
	wallets: z.array(
		z.object({
			managedWallet: reportManagedWalletSchema.nullable(),
			role: reportRoleSchema,
			metrics: reportAggregateSchema,
		}),
	),
	history: z.array(
		z.object({
			bucketStart: z.date(),
			bucketEnd: z.date(),
			metrics: reportAggregateSchema,
		}),
	),
	bucket: z.enum(['Day', 'Week', 'Month']),
	metadata: reportMetadataSchema,
});

const reportFiatCapabilitySchema = z.object({
	isConfigured: z.boolean(),
	isDemoKey: z.boolean(),
	/** Days of price history the configured key may read. Null when unlimited. */
	historyDays: z.number().int().nullable(),
	earliestPriceableDate: z.date().nullable(),
	currencies: z.array(z.string()),
	modes: z.array(z.enum(REPORT_FIAT_MODES)),
	attribution: z.string(),
	setupHint: z.string(),
});

export const reportFacetsOutputSchema = z.object({
	fiat: reportFiatCapabilitySchema,
	paymentSources: z.array(reportPaymentSourceSchema),
	managedWallets: z.array(
		z.object({
			id: z.string(),
			paymentSourceId: z.string(),
			type: z.enum([HotWalletType.Selling, HotWalletType.Purchasing]),
			walletAddress: z.string(),
			walletVkey: z.string(),
			collectionAddress: z.string().nullable(),
			note: z.string().nullable(),
			deletedAt: z.date().nullable(),
		}),
	),
});

export type ReportFilterInput = z.infer<typeof reportFilterSchema>;
export type ReportTransactionsInput = z.infer<typeof reportTransactionsInputSchema>;
export type ReportSummaryInput = z.infer<typeof reportSummaryInputSchema>;
