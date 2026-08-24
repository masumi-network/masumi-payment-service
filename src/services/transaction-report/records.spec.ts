import { describe, expect, it } from '@jest/globals';
import {
	buildReportRow,
	getReportRowWarnings,
	serializeReportRow,
	type ReportMetricWindow,
	type ReportRequestRecord,
} from './records';

const COHORT_WINDOW: ReportMetricWindow = {
	dateBasis: 'CreatedAt',
	from: new Date('2026-01-01T00:00:00.000Z'),
	to: new Date('2026-01-03T00:00:00.000Z'),
};

function blockTime(value: string): number {
	return Math.floor(new Date(value).getTime() / 1000);
}

function record(overrides: Partial<ReportRequestRecord> = {}): ReportRequestRecord {
	return {
		id: 'request-1',
		role: 'Seller',
		requestType: 'PaymentRequest',
		createdAt: new Date('2026-01-01T00:00:00.000Z'),
		blockchainIdentifier: 'chain-1',
		agentIdentifier: 'agent-1',
		agentName: 'Agent',
		onChainState: 'Withdrawn',
		metadata: null,
		managedWallet: {
			id: 'wallet-1',
			walletAddress: 'addr-wallet',
			walletVkey: 'wallet-vkey',
			collectionAddress: 'addr-collection',
			deletedAt: null,
		},
		counterpartyAddress: 'addr-counterparty',
		buyerReturnAddress: null,
		sellerReturnAddress: null,
		paymentSourceType: 'Web3CardanoV1',
		configuredFeeRatePermille: 50,
		unlockTime: 1_000n,
		collateralReturnLovelace: 2_000_000n,
		requestedFunds: [{ unit: 'lovelace', amount: 100_000_000n }],
		withdrawnForBuyer: [],
		withdrawnForSeller: [],
		buyerPayoutCompleteness: 'complete',
		sellerPayoutCompleteness: 'complete',
		buyerCardanoFees: 100_000n,
		sellerCardanoFees: 200_000n,
		transactions: [
			{
				id: 'tx-1',
				txHash: 'hash-1',
				status: 'Confirmed',
				newOnChainState: 'Withdrawn',
				blockTime: 1_767_225_700,
				fees: 400_000n,
				relatedRequestKeys: ['Seller:request-1'],
				relatedPaymentKeys: ['chain-1'],
			},
		],
		feeAllocationScope: 'single_request',
		isFeeReconciliationOwner: true,
		feeComponentScope: 'complete',
		...overrides,
	};
}

describe('buildReportRow', () => {
	it('keeps observed actor fees while marking actor and admin allocation partial', () => {
		const row = buildReportRow(record(), 'Billable', new Date('2026-01-02T00:00:00.000Z'), COHORT_WINDOW);
		expect(row.buyer).toBeNull();
		expect(row.seller?.grossRevenue).toEqual([{ unit: 'lovelace', amount: 100_000_000n }]);
		expect(row.cardanoFeeReconciliation).toMatchObject({
			buyerCardanoFees: 100_000n,
			sellerCardanoFees: 200_000n,
			adminCardanoFees: null,
			totalCardanoFees: 400_000n,
			completeness: 'partial',
		});
		expect(row.actorCardanoFeeAllocation.completeness).toBe('partial');
		expect(getReportRowWarnings(row).map((warning) => warning.code)).toContain(
			'ACTOR_CARDANO_FEE_EVENT_ALLOCATION_PARTIAL',
		);
	});

	it('discloses disputed buyer collateral payout ambiguity', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'DisputedWithdrawn',
				buyerPayoutCompleteness: 'partial',
			}),
			'Billable',
			new Date('2026-01-02T00:00:00.000Z'),
			COHORT_WINDOW,
		);

		expect(getReportRowWarnings(row)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'DISPUTED_PAYOUT_PARTIAL', message: expect.stringContaining('collateral') }),
			]),
		);
	});

	it('keeps incomplete related-payment evidence partial in exported scope metadata', () => {
		const row = buildReportRow(
			record({
				transactions: [
					{
						...record().transactions[0],
						relatedPaymentKeysComplete: false,
					},
				],
			}),
			'Billable',
			new Date('2026-01-06T00:00:00.000Z'),
			COHORT_WINDOW,
		);

		expect(row.feeComponentScope).toBe('partial');
	});

	it('gives one paired detail row the exact total without duplicating it', () => {
		const pairedTransaction = {
			id: 'tx-paired',
			txHash: 'hash-paired',
			status: 'Confirmed',
			newOnChainState: 'Withdrawn' as const,
			blockTime: 1_767_225_700,
			fees: 400_000n,
			relatedRequestKeys: ['Buyer:buyer-1', 'Seller:seller-1'],
			relatedPaymentKeys: ['chain-paired'],
		};
		const seller = buildReportRow(
			record({
				id: 'seller-1',
				blockchainIdentifier: 'chain-paired',
				transactions: [pairedTransaction],
				isFeeReconciliationOwner: false,
				feeComponentScope: 'partial',
			}),
			'Billable',
			new Date('2026-01-02T00:00:00.000Z'),
			COHORT_WINDOW,
		);
		const buyer = buildReportRow(
			record({
				id: 'buyer-1',
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				blockchainIdentifier: 'chain-paired',
				transactions: [pairedTransaction],
				isFeeReconciliationOwner: true,
				feeComponentScope: 'partial',
			}),
			'Billable',
			new Date('2026-01-02T00:00:00.000Z'),
			COHORT_WINDOW,
		);

		expect(seller.cardanoFeeReconciliation).toMatchObject({
			buyerCardanoFees: 100_000n,
			sellerCardanoFees: 200_000n,
			totalCardanoFees: null,
			adminCardanoFees: null,
			completeness: 'partial',
		});
		expect(buyer.cardanoFeeReconciliation).toMatchObject({
			buyerCardanoFees: 100_000n,
			sellerCardanoFees: 200_000n,
			totalCardanoFees: 400_000n,
			adminCardanoFees: null,
			completeness: 'partial',
		});
		expect([seller, buyer].filter((row) => row.cardanoFeeReconciliation.totalCardanoFees != null)).toHaveLength(1);
	});

	it('uses both stored actor fees for a seller-only paired transaction', () => {
		const row = buildReportRow(
			record({
				isFeeReconciliationOwner: true,
				feeComponentScope: 'partial',
				transactions: [
					{
						id: 'tx-paired',
						txHash: 'hash-paired',
						status: 'Confirmed',
						newOnChainState: 'Withdrawn',
						blockTime: 1_767_225_700,
						fees: 400_000n,
						relatedRequestKeys: ['Buyer:buyer-1', 'Seller:request-1'],
						relatedPaymentKeys: ['chain-1'],
					},
				],
			}),
			'Billable',
			new Date('2026-01-02T00:00:00.000Z'),
			COHORT_WINDOW,
		);

		expect(row.cardanoFeeReconciliation).toMatchObject({
			buyerCardanoFees: 100_000n,
			sellerCardanoFees: 200_000n,
			totalCardanoFees: 400_000n,
			adminCardanoFees: null,
			completeness: 'partial',
		});
	});

	it('keeps shared V2 admin fees partial', () => {
		const row = buildReportRow(
			record({
				paymentSourceType: 'Web3CardanoV2',
				feeAllocationScope: 'shared_or_unknown',
				feeComponentScope: 'partial',
				transactions: [
					{
						id: 'tx-shared',
						txHash: 'hash-shared',
						status: 'Confirmed',
						newOnChainState: 'Withdrawn',
						blockTime: 1_767_225_700,
						fees: 400_000n,
						relatedRequestKeys: ['Seller:request-1', 'Seller:request-2'],
						relatedPaymentKeys: ['chain-1', 'chain-2'],
					},
				],
			}),
			'Billable',
			new Date('2026-01-02T00:00:00.000Z'),
			COHORT_WINDOW,
		);
		expect(row.cardanoFeeReconciliation).toMatchObject({
			adminCardanoFees: null,
			totalCardanoFees: null,
			completeness: 'partial',
		});
		expect(getReportRowWarnings(row).map((warning) => warning.code)).toContain('CARDANO_FEE_RECONCILIATION_PARTIAL');
	});

	it('ignores old shared fee coverage when current-window evidence is complete', () => {
		const row = buildReportRow(
			record({
				paymentSourceType: 'Web3CardanoV2',
				buyerCardanoFees: 0n,
				sellerCardanoFees: 0n,
				feeAllocationScope: 'shared_or_unknown',
				feeComponentScope: 'partial',
				transactions: [
					{
						id: 'old-shared',
						txHash: 'old-shared-hash',
						status: 'Confirmed',
						newOnChainState: 'FundsLocked',
						blockTime: blockTime('2026-01-01T12:00:00.000Z'),
						fees: 100_000n,
						relatedRequestKeys: ['Buyer:old-counterpart', 'Seller:request-1'],
						relatedPaymentKeys: ['chain-1', 'chain-old-counterpart'],
					},
					{
						id: 'current-single',
						txHash: 'current-single-hash',
						status: 'Confirmed',
						newOnChainState: 'Withdrawn',
						blockTime: blockTime('2026-01-03T12:00:00.000Z'),
						fees: 50_000n,
						relatedRequestKeys: ['Seller:request-1'],
						relatedPaymentKeys: ['chain-1'],
					},
				],
			}),
			'Billable',
			new Date('2026-01-04T00:00:00.000Z'),
			{
				dateBasis: 'RevenueRecognizedAt',
				from: new Date('2026-01-03T00:00:00.000Z'),
				to: new Date('2026-01-04T00:00:00.000Z'),
			},
		);

		expect(row.cardanoFeeReconciliation).toEqual({
			buyerCardanoFees: 0n,
			sellerCardanoFees: 0n,
			adminCardanoFees: null,
			totalCardanoFees: 50_000n,
			completeness: 'partial',
		});
	});

	it.each(['CreatedAt', 'RevenueRecognizedAt'] as const)(
		'treats a shared zero fee as exact for %s reports',
		(dateBasis) => {
			const row = buildReportRow(
				record({
					paymentSourceType: 'Web3CardanoV2',
					buyerCardanoFees: 0n,
					sellerCardanoFees: 0n,
					feeAllocationScope: 'shared_or_unknown',
					feeComponentScope: 'partial',
					transactions: [
						{
							id: 'shared-zero',
							txHash: 'shared-zero-hash',
							status: 'Confirmed',
							newOnChainState: 'Withdrawn',
							blockTime: blockTime('2026-01-01T12:00:00.000Z'),
							fees: 0n,
							relatedRequestKeys: ['Buyer:shared-zero-sibling', 'Seller:request-1'],
							relatedPaymentKeys: ['chain-1', 'shared-zero-sibling-chain'],
						},
					],
				}),
				'Billable',
				new Date('2026-01-02T00:00:00.000Z'),
				{
					dateBasis,
					from: new Date('2026-01-01T00:00:00.000Z'),
					to: new Date('2026-01-02T00:00:00.000Z'),
				},
			);

			expect(row.cardanoFeeReconciliation).toEqual({
				buyerCardanoFees: 0n,
				sellerCardanoFees: 0n,
				adminCardanoFees: null,
				totalCardanoFees: 0n,
				completeness: 'partial',
			});
		},
	);

	it.each(['Pending', 'FailedViaTimeout', 'FailedViaManualReset', 'RolledBack'])(
		'marks on-chain fee reconciliation partial for %s-only transaction evidence',
		(status) => {
			const row = buildReportRow(
				record({
					transactions: [
						{
							id: `tx-${status.toLowerCase()}`,
							txHash: `hash-${status.toLowerCase()}`,
							status,
							newOnChainState: 'Withdrawn',
							blockTime: 1_767_225_700,
							fees: 400_000n,
							relatedRequestKeys: ['Seller:request-1'],
							relatedPaymentKeys: ['chain-1'],
						},
					],
				}),
				'Billable',
				new Date('2026-01-02T00:00:00.000Z'),
				COHORT_WINDOW,
			);

			expect(row.cardanoFeeReconciliation).toMatchObject({
				adminCardanoFees: null,
				totalCardanoFees: null,
				completeness: 'partial',
			});
			expect(row.seller).toMatchObject({
				grossRevenue: null,
				netRevenue: null,
				protocolFee: { amounts: null, completeness: 'insufficient_data' },
			});
		},
	);

	it('keeps generic confirmed evidence for fees but not wrong-state seller economics', () => {
		const wrongStateRecord = record({
			transactions: [
				{
					id: 'lock-only',
					txHash: 'lock-only-hash',
					status: 'Confirmed',
					newOnChainState: 'FundsLocked',
					blockTime: 1_767_225_700,
					fees: 400_000n,
					relatedRequestKeys: ['Seller:request-1'],
					relatedPaymentKeys: ['chain-1'],
				},
			],
		});
		const row = buildReportRow(wrongStateRecord, 'Billable', new Date('2026-01-02T00:00:00.000Z'), COHORT_WINDOW);
		const revenueWindowRow = buildReportRow(wrongStateRecord, 'Billable', new Date('2026-01-02T00:00:00.000Z'), {
			dateBasis: 'RevenueRecognizedAt',
			from: new Date('2026-01-01T00:00:00.000Z'),
			to: new Date('2026-01-02T00:00:00.000Z'),
		});

		for (const reportRow of [row, revenueWindowRow]) {
			expect(reportRow.seller).toMatchObject({
				grossRevenue: null,
				netRevenue: null,
				protocolFee: { amounts: null, completeness: 'insufficient_data' },
			});
		}
		expect(row.cardanoFeeReconciliation).toMatchObject({
			adminCardanoFees: null,
			totalCardanoFees: 400_000n,
			completeness: 'partial',
		});
	});

	it('builds buyer spend and refund metrics independently of revenue mode', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'lock',
						txHash: 'lock-hash',
						status: 'Confirmed',
						newOnChainState: 'FundsLocked',
						blockTime: blockTime('2026-01-01T12:00:00.000Z'),
						fees: 0n,
					},
					{
						id: 'refund',
						txHash: 'refund-hash',
						status: 'Confirmed',
						newOnChainState: 'RefundWithdrawn',
						blockTime: blockTime('2026-01-02T00:00:00.000Z'),
						fees: 0n,
					},
				],
			}),
			'CashReceived',
			new Date('2026-01-02T00:00:00.000Z'),
			COHORT_WINDOW,
		);
		expect(row.seller).toBeNull();
		expect(row.buyer?.returnedFunds).toEqual([{ unit: 'lovelace', amount: 100_000_000n }]);
		expect(row.buyer?.netSpend).toEqual([{ unit: 'lovelace', amount: 100_000n }]);
	});

	it('returns partial buyer gross without confirmed FundsLocked evidence', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'refund',
						txHash: 'refund-hash',
						status: 'Confirmed',
						newOnChainState: 'RefundWithdrawn',
						blockTime: blockTime('2026-01-02T00:00:00.000Z'),
						fees: 0n,
					},
				],
			}),
			'Billable',
			new Date('2026-01-02T12:00:00.000Z'),
			COHORT_WINDOW,
		);

		expect(row.buyer).toMatchObject({
			grossSpend: null,
			returnedFunds: [{ unit: 'lovelace', amount: 100_000_000n }],
			netSpend: null,
		});
	});

	it('returns partial buyer returns when confirmed evidence has the wrong terminal state', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'lock',
						txHash: 'lock-hash',
						status: 'Confirmed',
						newOnChainState: 'FundsLocked',
						blockTime: blockTime('2026-01-01T12:00:00.000Z'),
						fees: 0n,
					},
					{
						id: 'withdraw',
						txHash: 'withdraw-hash',
						status: 'Confirmed',
						newOnChainState: 'Withdrawn',
						blockTime: blockTime('2026-01-02T00:00:00.000Z'),
						fees: 0n,
					},
				],
			}),
			'Billable',
			new Date('2026-01-02T12:00:00.000Z'),
			COHORT_WINDOW,
		);

		expect(row.buyer).toMatchObject({
			grossSpend: [{ unit: 'lovelace', amount: 100_000_000n }],
			returnedFunds: null,
			netSpend: null,
		});
	});

	it('scopes a refund-only revenue window to the returned value and negative net', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'lock',
						txHash: 'lock-hash',
						status: 'Confirmed',
						newOnChainState: 'FundsLocked',
						blockTime: blockTime('2026-01-01T12:00:00.000Z'),
						fees: 200_000n,
					},
					{
						id: 'refund',
						txHash: 'refund-hash',
						status: 'Confirmed',
						newOnChainState: 'RefundWithdrawn',
						blockTime: blockTime('2026-01-03T12:00:00.000Z'),
						fees: 200_000n,
					},
				],
			}),
			'Billable',
			new Date('2026-01-04T00:00:00.000Z'),
			{
				dateBasis: 'RevenueRecognizedAt',
				from: new Date('2026-01-03T00:00:00.000Z'),
				to: new Date('2026-01-04T00:00:00.000Z'),
			},
		);

		expect(row.buyer).toMatchObject({
			grossSpend: [],
			returnedFunds: [{ unit: 'lovelace', amount: 100_000_000n }],
			cardanoFees: [],
			netSpend: [{ unit: 'lovelace', amount: -100_000_000n }],
		});
		expect(row.timestamps.buyerGrossSpendAt?.toISOString()).toBe('2026-01-01T12:00:00.000Z');
		expect(row.timestamps.buyerReturnedAt?.toISOString()).toBe('2026-01-03T12:00:00.000Z');
	});

	it('attaches buyer Cardano fees to an in-range lock event', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'lock',
						txHash: 'lock-hash',
						status: 'Confirmed',
						newOnChainState: 'FundsLocked',
						blockTime: blockTime('2026-01-01T12:00:00.000Z'),
						fees: 200_000n,
					},
					{
						id: 'refund',
						txHash: 'refund-hash',
						status: 'Confirmed',
						newOnChainState: 'RefundWithdrawn',
						blockTime: blockTime('2026-01-03T12:00:00.000Z'),
						fees: 200_000n,
					},
				],
			}),
			'Billable',
			new Date('2026-01-04T00:00:00.000Z'),
			{
				dateBasis: 'RevenueRecognizedAt',
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-01-02T00:00:00.000Z'),
			},
		);

		expect(row.buyer).toMatchObject({
			grossSpend: [{ unit: 'lovelace', amount: 100_000_000n }],
			returnedFunds: [],
			cardanoFees: [{ unit: 'lovelace', amount: 100_000n }],
			netSpend: [{ unit: 'lovelace', amount: 100_100_000n }],
		});
		expect(row.actorCardanoFeeAllocation.completeness).toBe('partial');
		expect(getReportRowWarnings(row).map((warning) => warning.code)).toContain(
			'ACTOR_CARDANO_FEE_EVENT_ALLOCATION_PARTIAL',
		);
	});

	it.each(['CreatedAt', 'FundsLockedAt'] as const)('keeps lifetime buyer values for %s cohorts', (dateBasis) => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'lock',
						txHash: 'lock-hash',
						status: 'Confirmed',
						newOnChainState: 'FundsLocked',
						blockTime: blockTime('2026-01-01T12:00:00.000Z'),
						fees: 200_000n,
					},
					{
						id: 'refund',
						txHash: 'refund-hash',
						status: 'Confirmed',
						newOnChainState: 'RefundWithdrawn',
						blockTime: blockTime('2026-01-03T12:00:00.000Z'),
						fees: 200_000n,
					},
				],
			}),
			'Billable',
			new Date('2026-01-04T00:00:00.000Z'),
			{
				dateBasis,
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-01-02T00:00:00.000Z'),
			},
		);

		expect(row.buyer).toMatchObject({
			grossSpend: [{ unit: 'lovelace', amount: 100_000_000n }],
			returnedFunds: [{ unit: 'lovelace', amount: 100_000_000n }],
			cardanoFees: [{ unit: 'lovelace', amount: 100_000n }],
			netSpend: [{ unit: 'lovelace', amount: 100_000n }],
		});
		expect(row.actorCardanoFeeAllocation).toMatchObject({ strategy: 'lifetime_cohort', completeness: 'partial' });
	});

	it('omits seller metrics when seller recognition is outside a revenue window', () => {
		const row = buildReportRow(record(), 'Billable', new Date('2026-01-04T00:00:00.000Z'), {
			dateBasis: 'RevenueRecognizedAt',
			from: new Date('2026-01-03T00:00:00.000Z'),
			to: new Date('2026-01-04T00:00:00.000Z'),
		});

		expect(row.seller).toMatchObject({ grossRevenue: [], cardanoFees: [], netRevenue: [] });
		expect(row.seller?.protocolFee).toMatchObject({ amounts: null, completeness: 'not_applicable' });
	});

	it('keeps seller metrics and fees at an in-range seller recognition event', () => {
		const row = buildReportRow(record(), 'Billable', new Date('2026-01-04T00:00:00.000Z'), {
			dateBasis: 'RevenueRecognizedAt',
			from: new Date('2026-01-01T00:00:00.000Z'),
			to: new Date('2026-01-02T00:00:00.000Z'),
		});

		expect(row.seller).toMatchObject({
			grossRevenue: [{ unit: 'lovelace', amount: 100_000_000n }],
			cardanoFees: [{ unit: 'lovelace', amount: 200_000n }],
			cardanoFeeTiming: 'accounting_allocation',
		});
		expect(row.actorCardanoFeeAllocation).toMatchObject({
			strategy: 'accounting_allocation',
			completeness: 'partial',
			attachedAt: new Date('2026-01-01T00:01:40.000Z'),
		});
	});

	it('keeps seller economics partial when exact state evidence lacks a chain time', () => {
		const row = buildReportRow(
			record({
				transactions: [
					{
						...record().transactions[0],
						blockTime: null,
					},
				],
			}),
			'Billable',
			new Date('2026-01-04T00:00:00.000Z'),
			{
				dateBasis: 'RevenueRecognizedAt',
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-01-02T00:00:00.000Z'),
			},
		);

		expect(row.seller).toMatchObject({
			grossRevenue: null,
			protocolFee: { amounts: null, completeness: 'insufficient_data' },
			cardanoFees: [],
			netRevenue: null,
		});
	});

	it('keeps buyer economics partial when exact state evidence lacks chain times', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'lock',
						txHash: 'lock-hash',
						status: 'Confirmed',
						newOnChainState: 'FundsLocked',
						blockTime: null,
						fees: 0n,
					},
					{
						id: 'refund',
						txHash: 'refund-hash',
						status: 'Confirmed',
						newOnChainState: 'RefundWithdrawn',
						blockTime: null,
						fees: 0n,
					},
				],
			}),
			'Billable',
			new Date('2026-01-04T00:00:00.000Z'),
			{
				dateBasis: 'RevenueRecognizedAt',
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-01-02T00:00:00.000Z'),
			},
		);

		expect(row.buyer).toMatchObject({
			grossSpend: null,
			returnedFunds: null,
			cardanoFees: [],
			netSpend: null,
		});
	});

	it.each([
		[null, []],
		['FundsOrDatumInvalid', null],
	] as const)('scopes %s buyer gross without a chain time', (onChainState, expectedGrossSpend) => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState,
				transactions: [],
			}),
			'Billable',
			new Date('2026-01-04T00:00:00.000Z'),
			{
				dateBasis: 'RevenueRecognizedAt',
				from: new Date('2026-01-01T00:00:00.000Z'),
				to: new Date('2026-01-02T00:00:00.000Z'),
			},
		);

		expect(row.buyer?.grossSpend).toEqual(expectedGrossSpend);
	});
});

describe('serializeReportRow', () => {
	it('keeps missing FundsLocked evidence partial at the JSON boundary', () => {
		const row = buildReportRow(
			record({
				role: 'Buyer',
				requestType: 'PurchaseRequest',
				onChainState: 'RefundWithdrawn',
				transactions: [
					{
						id: 'refund',
						txHash: 'refund-hash',
						status: 'Confirmed',
						newOnChainState: 'RefundWithdrawn',
						blockTime: blockTime('2026-01-02T00:00:00.000Z'),
						fees: 0n,
					},
				],
			}),
			'Billable',
			new Date('2026-01-02T12:00:00.000Z'),
			COHORT_WINDOW,
		);

		expect(serializeReportRow(row).buyer).toMatchObject({
			grossSpend: null,
			returnedFunds: [expect.objectContaining({ rawAmount: '100000000' })],
			netSpend: null,
		});
	});

	it('keeps BigInt values as exact strings at the JSON boundary', () => {
		const row = buildReportRow(
			record({ requestedFunds: [{ unit: 'lovelace', amount: 9_007_199_254_740_993n }] }),
			'Billable',
			new Date('2026-01-02T00:00:00.000Z'),
			COHORT_WINDOW,
		);
		const serialized = serializeReportRow(row);
		expect(serialized.seller?.grossRevenue?.[0]).toMatchObject({
			rawAmount: '9007199254740993',
			decimalAmount: '9007199254.740993',
		});
		expect(serialized.seller?.cardanoFeeTiming).toBe('stored_cumulative');
		expect(serialized.managedWallet).toMatchObject({ collectionAddress: 'addr-collection' });
		expect(serialized.cardanoFeeReconciliation).toMatchObject({
			buyerCardanoFees: {
				unit: 'lovelace',
				rawAmount: '100000',
				decimalAmount: '0.100000',
				decimals: 6,
				symbol: 'ADA',
			},
			sellerCardanoFees: {
				unit: 'lovelace',
				rawAmount: '200000',
				decimalAmount: '0.200000',
				decimals: 6,
				symbol: 'ADA',
			},
			adminCardanoFees: null,
			totalCardanoFees: expect.objectContaining({ rawAmount: '400000', symbol: 'ADA' }),
		});
		expect(serialized.actorCardanoFeeAllocation).toEqual({
			strategy: 'lifetime_cohort',
			completeness: 'partial',
			attachedAt: null,
		});
		expect(serialized.feeAllocationScope).toBe('single_request');
		expect(serialized.feeComponentScope).toBe('complete');
		expect(serialized.cardanoFeeReconciliation.isAggregationOwner).toBe(true);
		expect(JSON.stringify(serialized)).not.toContain('[object Object]');
	});
});
